// Crash reports from the VM: recognised and followed in the console log, decoded with the
// tree's script, shown with links and in Problems, and Decode Stack Trace for a pasted one.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { fakeGit, kernelTree, tempDir } from '../helpers/repo';
import { activate } from '../../extension';
import { decode, frames, OopsWatcher, START } from '../../oops';
import type { Configured } from '../../settings';

const pkg = JSON.parse(
	fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
);

describe('oops', () => {
	const trace = [
		'[    7.765285] sysrq: Trigger a crash',
		'[    7.765288] Kernel panic - not syncing: sysrq triggered crash',
		'[    7.768143] Call Trace:',
		'[    7.768643]  dump_stack_lvl (lib/dump_stack.c:94 lib/dump_stack.c:120)',
		'[    7.769682]  sysrq_handle_crash (drivers/tty/sysrq.c:154)',
		'[    7.771715]  ? handle_mm_fault (mm/memory.c:6876)',
		'[    7.771800]  foo+0x10/0x20 [mymod] (drivers/mine/foo.c:12)',
		'[    7.780000] ---[ end Kernel panic - not syncing: sysrq triggered crash ]---',
	].join('\n');

	const configured = (arch: string, buildDir = tempDir()): Configured => ({
		arch,
		variant: 'debug',
		config: 'defconfig',
		buildDir,
		makeArgs: [`O=${buildDir}`, `ARCH=${arch}`, 'CROSS_COMPILE='],
		configuredAt: new Date().toISOString(),
	});

	/** A tree with a decode_stacktrace.sh stand-in that prints its input unchanged. */
	const treeWithDecoder = (files: Record<string, string> = {}) => {
		const dir = kernelTree(files);
		fs.mkdirSync(path.join(dir, 'scripts'));
		fs.writeFileSync(path.join(dir, 'scripts/decode_stacktrace.sh'), '#!/bin/bash\ncat\n');
		return dir;
	};

	it('recognizes crash reports', () => {
		for (const line of [
			'Oops: 0002 [#1] SMP',
			'BUG: kernel NULL pointer dereference',
			'WARNING: CPU: 0 PID: 1 at x',
			'general protection fault',
			'Kernel panic - not syncing: x',
			'[    1.234567][    T1] WARNING: kernel/fork.c:12 at f+0x1/0x2, CPU#0',
		]) {
			assert.ok(START.test(line), line);
		}
		assert.ok(!START.test('[    1.0] Run /init as init process'));
		assert.ok(
			!START.test(
				'[    0.1] Speculative Return Stack Overflow: WARNING: See ' +
					'https://kernel.org/doc/html/latest/admin-guide/hw-vuln/srso.html ' +
					'for mitigation options.',
			),
		);
	});

	it('parses decoded frames, innermost location first, marking "?" frames', () => {
		assert.deepEqual(
			frames(trace).map(f => [f.func, f.file, f.line, f.reliable]),
			[
				['dump_stack_lvl', 'lib/dump_stack.c', 94, true],
				['sysrq_handle_crash', 'drivers/tty/sysrq.c', 154, true],
				['handle_mm_fault', 'mm/memory.c', 6876, false],
				['foo', 'drivers/mine/foo.c', 12, true],
			],
		);
	});

	it('follows a console log and reports a crash as it is written', async () => {
		const dir = tempDir();
		const log = path.join(dir, 'console.log');
		fs.writeFileSync(log, 'booting\n');
		const watcher = new OopsWatcher(dir);
		let found: string | undefined;
		watcher.found = async text => {
			found = text;
		};
		watcher.watch(log, configured('x86_64'));
		assert.equal(watcher.watching, log);
		for (const chunk of trace.match(/[\s\S]{1,60}/g) ?? []) {
			fs.appendFileSync(log, chunk);
			await new Promise(resolve => setTimeout(resolve, 30));
		}
		fs.appendFileSync(log, '\n');
		for (let i = 0; i < 40 && !found; i++) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		watcher.stop();
		assert.equal(watcher.watching, undefined);
		assert.ok(found, 'crash reported');
		assert.match(found, /^\[ +7\.765288\] Kernel panic/);
		assert.match(found, /end Kernel panic/);
	});

	it('shows a decoded report with links, and frames in Problems', async () => {
		const dir = treeWithDecoder();
		fs.mkdirSync(path.join(dir, 'drivers/tty'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'drivers/tty/sysrq.c'), 'x\n');
		const watcher = new OopsWatcher(dir);
		const result = await watcher.show(trace, configured('x86_64'), 'panic');
		assert.equal(result.frames.length, 4);
		const diagnostics = [...state.diagnostics].filter(([k]) => k.startsWith('kernel oops|'));
		assert.equal(
			diagnostics.reduce((n, [, d]) => n + d.length, 0),
			3,
			'the "?" frame is left out',
		);
		assert.match(String(state.shown.pop()?.uri), /^kernel-oops:\/1\/panic\.oops$/);
		const report = watcher.reports.get('1');
		assert.ok(report);
		const lines = report.split('\n');
		const links = watcher.provideDocumentLinks({
			lineCount: lines.length,
			lineAt: (i: number) => ({ text: lines[i] }),
		} as unknown as import('vscode').TextDocument);
		assert.equal(links.length, 1, 'only files that exist become links');
		assert.equal(links[0].target?.fragment, 'L154');
		assert.match(
			watcher.provideTextDocumentContent(
				vscode.Uri.parse('kernel-oops:/1/panic.oops') as unknown as import('vscode').Uri,
			),
			/^panic\n/,
		);
		watcher.diagnostics.dispose();
	});

	it('passes LLVM and CROSS_COMPILE to decode_stacktrace.sh', async () => {
		const dir = tempDir();
		fs.mkdirSync(path.join(dir, 'scripts'));
		fs.writeFileSync(
			path.join(dir, 'scripts/decode_stacktrace.sh'),
			'#!/bin/bash\necho "LLVM=$LLVM CROSS=$CROSS_COMPILE ARGS=$*"\n',
		);
		const st = {
			...configured('arm64'),
			makeArgs: ['O=x', 'LLVM=1', 'CROSS_COMPILE=aarch64-linux-gnu-'],
		};
		assert.equal(
			(await decode(dir, st, 'x')).trim(),
			`LLVM=1 CROSS=aarch64-linux-gnu- ARGS=${path.join(st.buildDir, 'vmlinux')} ${dir}`,
		);
	});

	it('watches the console of a QEMU boot, and decodes a selected or copied trace', async () => {
		const git = fakeGit('commit');
		try {
			const root = treeWithDecoder();
			vscode.workspace.workspaceFolders = [workspaceFolder(root)];
			const api = activate(extensionContext());
			assert.ok(api);
			const st = configured(api.settings.arch, api.settings.buildDir());
			api.runner.boot(st);
			assert.equal(api.oops.watching, api.runner.consoleLog(st));
			api.runner.stop();
			api.oops.stop();

			await vscode.commands.executeCommand('kernelWorkbench.oops.decode');
			assert.match(String(state.log.pop()?.message), /needs a configured and built kernel/);
			api.settings.saveConfigured(st);
			await vscode.commands.executeCommand('kernelWorkbench.oops.decode');
			assert.match(String(state.log.pop()?.message), /select a stack trace, or copy one/);
			assert.equal(state.shown.length, 0);
			state.clipboard = trace;
			await vscode.commands.executeCommand('kernelWorkbench.oops.decode');
			assert.match(String(state.shown.pop()?.uri), /^kernel-oops:\/1\//);
			vscode.window.activeTextEditor = {
				document: { uri: vscode.Uri.file('/x'), getText: () => 'Oops: 0002 [#1] SMP' },
				selection: { isEmpty: false },
			};
			await vscode.commands.executeCommand('kernelWorkbench.oops.decode');
			assert.match(
				String(state.shown.pop()?.uri),
				/^kernel-oops:\/2\/Oops 0002 \[#1\] SMP\.oops$/,
			);
			assert.match(
				api.oops.reports.get('2') ?? '',
				/^Oops: 0002 \[#1\] SMP\n/,
				'the selection',
			);
		} finally {
			git.restore();
		}
		const menus = pkg.contributes.menus;
		const inEditorMenu = menus['kernelWorkbench.editorContext'].find(
			(m: { command: string }) => m.command === 'kernelWorkbench.oops.decode',
		);
		assert.equal(inEditorMenu?.when, 'kernelWorkbench.active && editorHasSelection');
		assert.ok(
			menus.commandPalette.some(
				(m: { command: string }) => m.command === 'kernelWorkbench.oops.decode',
			),
		);
	});
});
