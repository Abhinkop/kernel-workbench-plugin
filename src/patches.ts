import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as checkpatch from './checkpatch';
import { git, gitStatus } from './git';
import type { Series } from './series';

export const COVER_TEMPLATE = `Subject of the series: what it does, in one line

Why the series is needed and how it is put together. The first paragraph
above is the cover letter's subject; this text is its body. git
format-patch adds the shortlog and the diffstat below it.
`;

/**
 * Patch generation for a Series: the cover letter (kept as the git branch description,
 * which git format-patch reads natively), the recipients from get_maintainer.pl, and git
 * format-patch itself.
 */
export class Patches {
	readonly root: string;
	/** The last generated series. */
	output: { dir: string; files: string[] } | undefined;
	/** The cover letter files being edited, by path: the branch each is for. */
	readonly editing = new Map<string, string>();
	/** The recipient files being edited. */
	readonly recipientFiles = new Set<string>();

	constructor(readonly series: Series) {
		this.root = series.root;
		series.context.subscriptions.push(
			vscode.workspace.onDidSaveTextDocument(document => this.saved(document)),
		);
	}

	get branch(): string {
		return this.series.info.branch;
	}

	get<T>(key: string, fallback: T): T {
		return this.series.context.workspaceState.get<T>(this.series.branchKey(key), fallback);
	}

	async set(key: string, value: unknown): Promise<void> {
		await this.series.context.workspaceState.update(this.series.branchKey(key), value);
		this.series.changed();
	}

	get to(): string[] {
		return this.get<string[]>('to', []);
	}

	get cc(): string[] {
		return this.get<string[]>('cc', []);
	}

	get prefix(): string {
		return this.get('prefix', 'PATCH');
	}

	/** The cover letter (the branch description), or '' when there is none. */
	async cover(): Promise<string> {
		if (!this.branch) {
			return '';
		}
		const result = await gitStatus(this.root, [
			'config',
			'--get',
			`branch.${this.branch}.description`,
		]);
		return result.stdout.replace(/\n+$/, '');
	}

	/** Where the files being edited go. */
	private storage(): string {
		const context = this.series.context;
		const dir = (context.storageUri ?? context.globalStorageUri).fsPath;
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	/** Edits the cover letter in an editor tab; saving stores it as the branch description. */
	async editCover(): Promise<void> {
		if (!this.branch) {
			vscode.window.showErrorMessage(
				'Kernel: HEAD is detached; the cover letter is kept per branch.',
			);
			return;
		}
		const name = this.branch.replace(/[^\w.-]+/g, '_');
		const file = path.join(this.storage(), `cover-letter-${name}.txt`);
		fs.writeFileSync(file, `${(await this.cover()) || COVER_TEMPLATE.trimEnd()}\n`);
		this.editing.set(file, this.branch);
		await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
		vscode.window.showInformationMessage(
			`Kernel: save to store the cover letter of "${this.branch}". ` +
				'The first paragraph is the subject.',
		);
	}

	/**
	 * Edits To and Cc in an editor tab, one address per line under "To:" and "Cc:"; saving
	 * stores them for the branch.
	 */
	async editRecipients(): Promise<void> {
		const name = (this.branch || 'detached').replace(/[^\w.-]+/g, '_');
		const file = path.join(this.storage(), `recipients-${name}.txt`);
		fs.writeFileSync(
			file,
			[
				`# Recipients of the series on ${this.branch || 'the detached HEAD'}: ` +
					'one address per line.',
				'# Save to apply. Lines starting with # are ignored.',
				'To:',
				...this.to,
				'',
				'Cc:',
				...this.cc,
				'',
			].join('\n'),
		);
		this.recipientFiles.add(file);
		await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
	}

	/** Asks for the subject prefix (PATCH, PATCH net-next, RFC PATCH, ...). */
	async editPrefix(): Promise<void> {
		const value = await vscode.window.showInputBox({
			title: 'Subject prefix',
			value: this.prefix,
			prompt: 'e.g. PATCH, PATCH net-next, RFC PATCH',
		});
		if (value !== undefined) {
			await this.set('prefix', value.trim() || 'PATCH');
		}
	}

	/** A saved recipients or cover letter file is stored. */
	async saved(document: vscode.TextDocument): Promise<void> {
		if (this.recipientFiles.has(document.uri.fsPath)) {
			const to: string[] = [];
			const cc: string[] = [];
			let into = to;
			for (const raw of document.getText().split('\n')) {
				const line = raw.trim();
				if (!line || line.startsWith('#')) {
					continue;
				}
				if (/^to:$/i.test(line)) {
					into = to;
					continue;
				}
				if (/^cc:$/i.test(line)) {
					into = cc;
					continue;
				}
				into.push(line.replace(/,$/, ''));
			}
			await this.set('to', to);
			await this.set('cc', cc);
			return;
		}
		const branch = this.editing.get(document.uri.fsPath);
		if (!branch) {
			return;
		}
		const text = document.getText().replace(/\s+$/, '');
		await git(this.root, ['config', `branch.${branch}.description`, text]);
		this.series.changed();
	}

	/**
	 * To and Cc from scripts/get_maintainer.pl on the series: maintainers and reviewers go
	 * to To, mailing lists and everyone else to Cc.
	 */
	async fillRecipients(): Promise<void> {
		const { mergeBase, commits } = this.series.info;
		if (!mergeBase || !commits.length) {
			vscode.window.showErrorMessage('Kernel: no commits in the series.');
			return;
		}
		const mbox = await git(this.root, ['format-patch', '--stdout', `${mergeBase}..HEAD`]);
		const out = await new Promise<string>((resolve, reject) => {
			const child = execFile(
				'perl',
				[path.join(this.root, 'scripts', 'get_maintainer.pl')],
				{ cwd: this.root, maxBuffer: 16 << 20 },
				(error, stdout, stderr) =>
					error && !stdout ? reject(new Error(stderr || error.message)) : resolve(stdout),
			);
			child.stdin?.end(mbox);
		});
		const { to, cc } = splitRecipients(out);
		await this.set('to', to);
		await this.set('cc', cc);
	}

	/**
	 * git format-patch into the output directory. Blocked while checkpatch reports errors,
	 * unless the user says to generate anyway.
	 */
	async generate(): Promise<void> {
		const series = this.series;
		await series.refresh();
		const { mergeBase, commits } = series.info;
		if (!mergeBase || !commits.length) {
			vscode.window.showErrorMessage(
				`Kernel: ${series.info.error ?? 'no commits in the series.'}`,
			);
			return;
		}

		// Every commit gets a current checkpatch result first.
		const unchecked = commits.filter(c => !series.reports.has(c.hash));
		if (unchecked.length) {
			await series.withBusy('checkpatch before generating', async () => {
				for (const c of unchecked) {
					const report = await checkpatch.checkCommit(this.root, c.hash);
					series.reports.set(c.hash, report);
					await series.problems.set(c.hash, report.findings, c.hash);
				}
			});
		}
		const failing = commits.filter(c => (series.reports.get(c.hash)?.errors ?? 0) > 0);
		if (failing.length) {
			const errors = failing.reduce(
				(n, c) => n + (series.reports.get(c.hash)?.errors ?? 0),
				0,
			);
			const pick = await vscode.window.showWarningMessage(
				`checkpatch reports ${errors} error${errors > 1 ? 's' : ''} ` +
					`in ${failing.length} of ${commits.length} commits.`,
				{ modal: true, detail: failing.map(c => `${c.short} ${c.subject}`).join('\n') },
				'Generate Anyway',
			);
			if (pick !== 'Generate Anyway') {
				return;
			}
		}

		const multi = commits.length > 1;
		const cover = await this.cover();
		if (multi && (!cover || cover.startsWith(COVER_TEMPLATE.split('\n')[0]))) {
			const pick = await vscode.window.showWarningMessage(
				'The cover letter has not been written yet.',
				{
					modal: true,
					detail:
						'A series of more than one patch gets a cover letter. ' +
						'Without text it is sent with "*** SUBJECT HERE ***".',
				},
				'Edit Cover Letter',
				'Generate Anyway',
			);
			if (pick === 'Edit Cover Letter') {
				await this.editCover();
				return;
			}
			if (pick !== 'Generate Anyway') {
				return;
			}
		}

		const dir = this.outputDir();
		const old = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.patch')) : [];
		if (old.length) {
			const pick = await vscode.window.showWarningMessage(
				`${path.relative(this.root, dir)} already has ${old.length} patch files.`,
				{ modal: true },
				'Replace Them',
			);
			if (pick !== 'Replace Them') {
				return;
			}
			for (const f of old) {
				fs.rmSync(path.join(dir, f));
			}
		}
		fs.mkdirSync(dir, { recursive: true });

		const args = [
			'format-patch',
			'-o',
			dir,
			`--base=${mergeBase}`,
			`--subject-prefix=${this.prefix}`,
		];
		if (series.version > 1) {
			args.push(`-v${series.version}`);
		}
		if (multi) {
			args.push('--cover-letter', '--cover-from-description=subject');
		}
		for (const a of this.to) {
			args.push(`--to=${a}`);
		}
		for (const a of this.cc) {
			args.push(`--cc=${a}`);
		}
		args.push(`${mergeBase}..HEAD`);
		let out: string;
		try {
			out = await git(this.root, args);
		} catch (e) {
			vscode.window.showErrorMessage(
				`Kernel: git format-patch failed: ${(e as Error).message}`,
			);
			return;
		}
		const files = out
			.split('\n')
			.filter(Boolean)
			.map(f => path.basename(f));
		this.output = { dir, files };
		series.changed();
		await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, files[0])), {
			preview: true,
		});
		vscode.window.showInformationMessage(
			`Kernel: ${files.length} patch file${files.length > 1 ? 's' : ''} ` +
				`in ${path.relative(this.root, dir)}.`,
		);
	}

	/** kernelWorkbench.patches.outputDirectory for the branch and version. */
	outputDir(): string {
		const template = this.series.settings.get(
			'patches.outputDirectory',
			'patches/${branch}/v${version}',
		);
		const branch = (this.branch || 'detached').replace(/[^\w.-]+/g, '_');
		return path.resolve(
			this.root,
			template
				.replace(/\$\{branch\}/g, branch)
				.replace(/\$\{version\}/g, String(this.series.version)),
		);
	}
}

/**
 * Splits get_maintainer.pl output into To (maintainers, reviewers) and Cc (lists and
 * everyone else), dropping the role annotations.
 */
export function splitRecipients(out: string): { to: string[]; cc: string[] } {
	const to: string[] = [];
	const cc: string[] = [];
	for (const line of out.split('\n')) {
		const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(line.trim());
		const address = (m ? m[1] : line).trim();
		if (!address || !address.includes('@')) {
			continue;
		}
		const role = m ? m[2] : '';
		(/\b(maintainer|reviewer):/.test(role) ? to : cc).push(address);
	}
	return { to, cc };
}
