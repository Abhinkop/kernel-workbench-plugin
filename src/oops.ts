import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Configured, Settings } from './settings';

/** The scheme of the decoded reports' documents. */
export const SCHEME = 'kernel-oops';

/**
 * The first line of a kernel crash report, after the printk time and caller prefixes.
 * Anchored, so that messages merely containing "WARNING:" (the SRSO mitigation notice)
 * are not taken for a WARN() splat, which reads "WARNING: CPU: n PID: n at ..." or
 * "WARNING: file:line at ...".
 */
export const START = new RegExp(
	'^\\s*(?:\\[[^\\]]*\\]\\s*)*(' +
		[
			'Oops',
			'BUG:',
			'WARNING: (?:CPU:|\\S+:\\d+ at )',
			'Kernel panic - not syncing',
			'general protection fault',
			'Unable to handle kernel',
			'kernel BUG at',
			'Internal error:',
			'BUG kernel NULL pointer',
		].join('|') +
		')',
);
/** The last line of one. */
export const END = /---\[ end (trace|Kernel panic)/;

/** A frame of a decoded report that has a source location. */
export interface Frame {
	func: string;
	file: string;
	line: number;
	/** Frames the kernel marks with "?" are unreliable leftovers on the stack. */
	reliable: boolean;
	text: string;
}

/**
 * Decodes a crash report with the tree's scripts/decode_stacktrace.sh against the build's
 * vmlinux; the tools follow the build's LLVM= and CROSS_COMPILE=.
 */
export function decode(root: string, state: Configured, text: string): Promise<string> {
	const env: Record<string, string> = {};
	for (const arg of state.makeArgs) {
		const m = /^(LLVM|CROSS_COMPILE)=(.*)$/.exec(arg);
		if (m && m[2]) {
			env[m[1]] = m[2];
		}
	}
	return new Promise((resolve, reject) => {
		const child = execFile(
			'bash',
			[
				path.join(root, 'scripts', 'decode_stacktrace.sh'),
				path.join(state.buildDir, 'vmlinux'),
				root,
			],
			{ cwd: root, maxBuffer: 16 << 20, env: { ...process.env, ...env } },
			(error, stdout, stderr) =>
				error && !stdout ? reject(new Error(stderr || error.message)) : resolve(stdout),
		);
		child.stdin?.end(text);
	});
}

/**
 * The frames with a source location in decoded output, which looks like
 *   [    7.769682]  sysrq_handle_crash (drivers/tty/sysrq.c:154)
 *   [    7.768643]  dump_stack_lvl (lib/dump_stack.c:94 lib/dump_stack.c:120)
 * where an inlined call lists the innermost location first.
 */
export function frames(decoded: string): Frame[] {
	// The time, "? ", the function, its offset, [module], and "(file:line".
	const frame = new RegExp(
		'^(?:\\[[\\s\\d.]*\\])?\\s*(\\? )?([\\w.]+)' +
			'(?:\\+0x[0-9a-f]+/0x[0-9a-f]+)? (?:\\[[\\w-]+\\] )?' +
			'\\((\\S+\\.[chS]):(\\d+)',
	);
	const out: Frame[] = [];
	for (const text of decoded.split('\n')) {
		const m = frame.exec(text);
		if (m) {
			out.push({ func: m[2], file: m[3], line: +m[4], reliable: !m[1], text: text.trim() });
		}
	}
	return out;
}

/** A report's first line without the printk prefix: what the crash was. */
export function titleOf(text: string): string | undefined {
	return (
		text
			.split('\n')
			.find(l => START.test(l))
			?.replace(/^\[[\s\d.]+\]\s*/, '')
			.trim() || undefined
	);
}

/** Watches the VM's console log, and decodes and reports crashes. */
export class OopsWatcher
	implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider
{
	/** Decoded reports, by document id. */
	readonly reports = new Map<string, string>();
	count = 0;
	readonly diagnostics = vscode.languages.createDiagnosticCollection('kernel oops');
	/** The console log being followed, while one is. */
	watching: string | undefined;
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly root: string) {}

	/** Follows a console log from the start (the VM truncates it at boot). */
	watch(file: string, state: Configured): void {
		this.stop();
		this.watching = file;
		let offset = 0;
		let partial = '';
		let report: string[] | undefined;
		let quietTicks = 0;
		const flush = () => {
			const lines = report;
			report = undefined;
			if (lines) {
				this.found(lines.join('\n'), state);
			}
		};
		this.timer = setInterval(() => {
			let size: number;
			try {
				size = fs.statSync(file).size;
			} catch {
				return;
			}
			if (size < offset) {
				offset = 0; // a new boot truncated it
			}
			if (size === offset) {
				if (report && ++quietTicks >= 4) {
					flush(); // 2 s without more output ends a report
				}
				return;
			}
			quietTicks = 0;
			const fd = fs.openSync(file, 'r');
			const buf = Buffer.alloc(size - offset);
			fs.readSync(fd, buf, 0, buf.length, offset);
			fs.closeSync(fd);
			offset = size;
			const lines = (partial + buf.toString('utf8').replace(/\r/g, '')).split('\n');
			partial = lines.pop() ?? '';
			for (const line of lines) {
				if (!report && START.test(line)) {
					report = [];
				}
				if (!report) {
					continue;
				}
				report.push(line);
				if (END.test(line) || report.length >= 400) {
					flush();
				}
			}
		}, 500);
		this.timer.unref(); // never what keeps the extension host alive
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.watching = undefined;
	}

	/** A crash in the console: names it, and offers the decoded trace. */
	async found(text: string, state: Configured): Promise<void> {
		const title = titleOf(text) ?? 'kernel crash';
		const pick = await vscode.window.showErrorMessage(
			`Kernel: the VM reported "${title}".`,
			'Show Decoded Trace',
		);
		if (pick) {
			await this.show(text, state, title);
		}
	}

	/** Decodes and opens a report; the reliable frames also go to Problems. */
	async show(
		text: string,
		state: Configured,
		title = 'stack trace',
	): Promise<{ decoded: string; frames: Frame[] }> {
		let decoded: string;
		try {
			decoded = await decode(this.root, state, text);
		} catch (e) {
			decoded = `${text}\n\n(decode_stacktrace.sh failed: ${(e as Error).message})`;
		}
		const found = frames(decoded);
		const byFile = new Map<string, vscode.Diagnostic[]>();
		found
			.filter(f => f.reliable)
			.forEach((f, i) => {
				const diagnostic = new vscode.Diagnostic(
					new vscode.Range(f.line - 1, 0, f.line - 1, 1000),
					`${title}: frame ${i}: ${f.func}`,
					i === 0
						? vscode.DiagnosticSeverity.Error
						: vscode.DiagnosticSeverity.Information,
				);
				diagnostic.source = 'oops';
				const abs = path.resolve(this.root, f.file);
				byFile.set(abs, [...(byFile.get(abs) ?? []), diagnostic]);
			});
		this.diagnostics.clear();
		for (const [file, list] of byFile) {
			this.diagnostics.set(vscode.Uri.file(file), list);
		}

		const id = String(++this.count);
		this.reports.set(
			id,
			`${title}\nvmlinux: ${path.join(state.buildDir, 'vmlinux')}\n` +
				`${found.length} frames with source locations (also in Problems)\n\n${decoded}`,
		);
		const name = title
			.replace(/[\\/:*?"<>|]+/g, ' ')
			.replace(/\s+/g, ' ')
			.slice(0, 60);
		const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/${name}.oops` });
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
			preview: false,
		});
		return { decoded, frames: found };
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.reports.get(uri.path.split('/')[1]) ?? '';
	}

	/** Every "path/file.c:123" of a file in the tree becomes a link. */
	provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
		const links: vscode.DocumentLink[] = [];
		for (let i = 0; i < document.lineCount; i++) {
			const text = document.lineAt(i).text;
			for (const m of text.matchAll(/(?<![\w/.-])([\w./-]+\.[chS]):(\d+)/g)) {
				const abs = path.resolve(this.root, m[1]);
				if (!fs.existsSync(abs)) {
					continue;
				}
				const target = vscode.Uri.file(abs).with({ fragment: `L${m[2]}` });
				const start = m.index ?? 0;
				links.push(
					new vscode.DocumentLink(
						new vscode.Range(i, start, i, start + m[0].length),
						target,
					),
				);
			}
		}
		return links;
	}
}

/** The watcher, its documents and links, and Kernel: Decode Stack Trace. */
export function registerOops(context: vscode.ExtensionContext, settings: Settings): OopsWatcher {
	const watcher = new OopsWatcher(settings.root);
	context.subscriptions.push(
		watcher.diagnostics,
		{ dispose: () => watcher.stop() },
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, watcher),
		vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, watcher),
		vscode.commands.registerCommand('kernelWorkbench.oops.decode', async () => {
			const state = settings.configured();
			if (!state) {
				vscode.window.showErrorMessage(
					'Kernel: decoding needs a configured and built kernel (Kernel tab).',
				);
				return;
			}
			const editor = vscode.window.activeTextEditor;
			const selected =
				editor && !editor.selection.isEmpty
					? editor.document.getText(editor.selection)
					: '';
			const text = selected || (await vscode.env.clipboard.readText());
			if (!text.trim()) {
				vscode.window.showWarningMessage(
					'Kernel: select a stack trace, or copy one to the clipboard, ' +
						'then run this again.',
				);
				return;
			}
			await watcher.show(text, state, titleOf(text) ?? 'stack trace');
		}),
	);
	return watcher;
}
