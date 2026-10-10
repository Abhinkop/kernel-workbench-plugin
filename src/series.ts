import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as checkpatch from './checkpatch';
import type { Report } from './checkpatch';
import { exists, git, gitStatus, log } from './git';
import type { Commit } from './git';
import type { OptionSpec } from './options';
import { Patches } from './patches';
import type { Settings } from './settings';
import { runTask, sq } from './tasks';
import { onPath } from './tools';

/**
 * The series: the commits of the current branch on top of a base, the way they will become
 * a patch series.
 */
export interface SeriesInfo {
	/** The branch's name, or '' when HEAD is detached. */
	branch: string;
	/** The ref the series is based on. */
	base?: string;
	/** Where the series starts. */
	mergeBase?: string;
	/** Oldest first: in patch order. */
	commits: Commit[];
	error?: string;
}

const MAX_COMMITS = 200;

/** The series on the current branch, and its checks. */
export class Series {
	readonly root: string;
	info: SeriesInfo = { branch: '', commits: [] };
	/** checkpatch results, by commit hash. */
	readonly reports = new Map<string, Report>();
	/** The working changes' result; null: checked, no changes. */
	working: Report | undefined | null = undefined;
	/** What is running, while something is. */
	busy = '';
	/** What the last build checks found. */
	lastBuild = '';
	readonly problems: checkpatch.Problems;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(
		readonly context: vscode.ExtensionContext,
		readonly settings: Settings,
	) {
		this.root = settings.root;
		this.problems = new checkpatch.Problems(this.root);
	}

	changed(): void {
		this._onDidChange.fire();
	}

	/** A workspaceState key for the branch. */
	branchKey(key: string): string {
		return `kernelWorkbench.series.${key}:${this.info.branch || 'HEAD'}`;
	}

	get version(): number {
		return this.context.workspaceState.get<number>(this.branchKey('version'), 1);
	}

	async setVersion(version: number): Promise<void> {
		await this.context.workspaceState.update(this.branchKey('version'), Math.max(1, version));
		this.changed();
	}

	/**
	 * The base: the one picked for this branch, else the branch's upstream, else
	 * kernelWorkbench.patches.base, if it exists.
	 */
	async resolveBase(): Promise<string | undefined> {
		const picked = this.context.workspaceState.get<string>(this.branchKey('base'));
		if (picked && (await exists(this.root, picked))) {
			return picked;
		}
		const upstream = await gitStatus(this.root, [
			'rev-parse',
			'--abbrev-ref',
			'--symbolic-full-name',
			'@{upstream}',
		]);
		if (upstream.code === 0 && upstream.stdout.trim()) {
			return upstream.stdout.trim();
		}
		const configured = this.settings.get('patches.base', 'origin/master');
		if (configured && (await exists(this.root, configured))) {
			return configured;
		}
		return undefined;
	}

	/** Reads the branch, its base and the commits over it. */
	async refresh(): Promise<void> {
		const head = await gitStatus(this.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
		const branch = head.stdout.trim();
		this.info = { branch, commits: [] };
		try {
			const base = await this.resolveBase();
			if (!base) {
				const configured = this.settings.get('patches.base', 'origin/master');
				this.info.error =
					`No base: "${configured}" does not exist here. ` +
					'Pick the commit or ref the series is based on.';
			} else {
				const mergeBase = (await git(this.root, ['merge-base', base, 'HEAD'])).trim();
				const commits = await log(this.root, [
					'--reverse',
					'--no-merges',
					`${mergeBase}..HEAD`,
				]);
				this.info = { branch, base, mergeBase, commits: commits.slice(-MAX_COMMITS) };
				if (commits.length > MAX_COMMITS) {
					this.info.error =
						`${commits.length} commits on top of ${base}: is that the right base? ` +
						`Showing the last ${MAX_COMMITS}.`;
				}
			}
		} catch (e) {
			this.info.error = (e as Error).message;
		}
		// Results for commits no longer in the series go away.
		const hashes = new Set(this.info.commits.map(c => c.hash));
		for (const hash of [...this.reports.keys()]) {
			if (!hashes.has(hash)) {
				this.reports.delete(hash);
			}
		}
		this.problems.prune(origin => origin === 'working' || hashes.has(origin));
		this.changed();
	}

	/** Asks for the base: a recent ref, or a commit or ref typed in. */
	async pickBase(): Promise<void> {
		const out = await git(this.root, [
			'for-each-ref',
			'--sort=-committerdate',
			'--count=200',
			'--format=%(refname:short)',
			'refs/heads',
			'refs/remotes',
			'refs/tags',
		]);
		const refs = out.split('\n').filter(r => r && !r.endsWith('/HEAD'));
		const enter = '$(edit) Enter a commit or ref…';
		const pick = await vscode.window.showQuickPick([enter, ...refs], {
			title: 'Base of the series',
		});
		let base = pick;
		if (pick === enter) {
			base = await vscode.window.showInputBox({
				title: 'Base commit or ref',
				prompt: 'e.g. v6.12, origin/master, a commit hash',
			});
		}
		if (!base) {
			return;
		}
		if (!(await exists(this.root, base))) {
			vscode.window.showErrorMessage(`Kernel: "${base}" is not a commit here.`);
			return;
		}
		await this.context.workspaceState.update(this.branchKey('base'), base);
		await this.refresh();
	}

	/** checkpatch on the uncommitted changes. */
	async checkWorking(): Promise<void> {
		await this.withBusy('checkpatch: working changes', async () => {
			const report = await checkpatch.checkWorkingChanges(this.root);
			this.working = report ?? null;
			await this.problems.set('working', report ? report.findings : []);
		});
	}

	/**
	 * checkpatch on every commit, then W=1 (and sparse and Coccinelle, if enabled) on the C
	 * files the series and the working tree touch.
	 */
	async checkSeries(): Promise<void> {
		await this.refresh();
		const { commits, mergeBase } = this.info;
		if (!mergeBase) {
			vscode.window.showErrorMessage(`Kernel: ${this.info.error ?? 'no series to check.'}`);
			return;
		}
		await this.withBusy(`checkpatch: ${commits.length} commits`, async () => {
			let done = 0;
			const queue = [...commits];
			const worker = async () => {
				for (let c = queue.shift(); c; c = queue.shift()) {
					const report = await checkpatch.checkCommit(this.root, c.hash);
					this.reports.set(c.hash, report);
					await this.problems.set(c.hash, report.findings, c.hash);
					this.busy = `checkpatch: ${++done}/${commits.length}`;
					this.changed();
				}
			};
			await Promise.all([worker(), worker(), worker(), worker()]);
		});
		await this.buildChecks(mergeBase);
	}

	/** The build checks on what changed since the base. */
	async buildChecks(mergeBase: string): Promise<void> {
		const out = await git(this.root, ['diff', '--name-only', '--diff-filter=d', mergeBase]);
		await this.compileChecks(out.split('\n').filter(Boolean));
	}

	/**
	 * Compiles the touched C files with W=1 (and C=2 for sparse) in the Kernel tab's
	 * configured build, with diagnostics in Problems. Single objects are built even when the
	 * file is disabled in .config.
	 */
	async compileChecks(changed: string[]): Promise<void> {
		const state = this.settings.configured();
		const files = changed.filter(
			f => /\.c$/.test(f) && !f.startsWith('tools/') && !f.startsWith('scripts/'),
		);
		if (!files.length) {
			this.lastBuild = 'no C files changed';
			this.changed();
			return;
		}
		if (!state) {
			this.lastBuild = 'skipped: configure a build in the Kernel tab for W=1';
			this.changed();
			return;
		}
		const objects = files.map(f => f.replace(/\.c$/, '.o'));
		const sparse = this.settings.get('check.sparse', false);
		const extra = ['W=1', ...(sparse ? ['C=2'] : [])];
		const logFile = path.join(os.tmpdir(), `kernel-workbench-check-${process.pid}.log`);
		const make = ['make', ...this.settings.makeArgs(state), this.settings.jobs(), '-k']
			.concat(extra, objects)
			.map(sq)
			.join(' ');
		// The output is kept to count the findings, and to notice that Kbuild skipped
		// sparse, which it only mentions in passing.
		const count = objects.length;
		const code = await runTask(
			this.settings.folder,
			`Check build ${extra.join(' ')} (${count} file${count > 1 ? 's' : ''})`,
			'bash',
			['-c', `set -o pipefail; ${make} 2>&1 | tee ${sq(logFile)}`],
			{ problemMatcher: ['$gcc'], step: 'check' },
		);
		const out = readAndRemove(logFile);
		const matches = (re: RegExp) => (out.match(re) ?? []).length;
		const parts = [`${extra.join(' ')} on ${count} file${count > 1 ? 's' : ''}:`];
		const errors = matches(/^\S+:\d+:\d+: error:/gm);
		const warnings = matches(/^\S+:\d+:\d+: warning:/gm);
		parts.push(
			errors || warnings
				? `${errors} errors, ${warnings} warnings (see Problems)`
				: code === 0
					? 'clean'
					: 'build failed (see the terminal)',
		);
		if (sparse && /sparse is not available or not up to date/.test(out)) {
			parts.push(
				'· sparse was NOT run: it is missing or too old for this kernel ' +
					'(build a current sparse from git.kernel.org)',
			);
		}
		this.lastBuild = parts.join(' ');
		this.changed();

		if (this.settings.get('check.coccinelle', false)) {
			// coccicheck with O= scans the build directory instead of M=, and it reports paths
			// relative to M=; run it in the source tree (it writes nothing there) and prefix
			// the directory.
			const arch = state.makeArgs.find(a => a.startsWith('ARCH=')) ?? '';
			const dirs = [...new Set(files.map(f => path.dirname(f)))];
			const jobs = this.settings.jobs();
			const script = [
				'set -o pipefail',
				...dirs.map(d => {
					const make = `make ${sq(arch)} ${jobs} coccicheck MODE=report M=${sq(d)}`;
					return `${make} 2>&1 | sed -e ${sq(`s|^[.]/|${d}/|`)}`;
				}),
			].join('\n');
			const result = await runTask(
				this.settings.folder,
				`Coccinelle (${dirs.length} dir${dirs.length > 1 ? 's' : ''})`,
				'bash',
				['-c', script],
				{ problemMatcher: ['$kernel-coccinelle'], step: 'coccinelle' },
			);
			const outcome =
				result === 0 ? 'done (see Problems)' : 'failed (see the terminal; needs ocaml-nox)';
			this.lastBuild += ` · Coccinelle: ${outcome}`;
			this.changed();
		}
	}

	/** git clang-format: reformats only the lines changed since the base. */
	async formatChanged(): Promise<void> {
		if (!onPath('git-clang-format')) {
			vscode.window.showErrorMessage(
				'Kernel: git clang-format is not installed ' +
					'(Debian/Ubuntu: sudo apt install clang-format).',
			);
			return;
		}
		await this.refresh();
		if (!this.info.mergeBase) {
			vscode.window.showErrorMessage(
				`Kernel: ${this.info.error ?? 'no base for the series.'}`,
			);
			return;
		}
		// git clang-format exits 1 when it changed files.
		const script = [
			`git clang-format ${sq(this.info.mergeBase)}`,
			'rc=$?',
			'if [ $rc = 1 ]; then echo "==> reformatted the lines above; ' +
				'review with git diff, then amend or fixup"; exit 0; fi',
			'exit $rc',
		].join('\n');
		await runTask(this.settings.folder, 'Format changed lines', 'bash', ['-c', script], {
			step: 'format',
		});
	}

	/** checkpatch's raw output for a commit (or 'working') in an editor tab. */
	async showReport(hash: string): Promise<void> {
		const report = hash === 'working' ? this.working : this.reports.get(hash);
		if (!report) {
			return;
		}
		const commit = this.info.commits.find(c => c.hash === hash);
		const title = commit
			? `checkpatch ${commit.short} ${commit.subject}`
			: 'checkpatch: working changes';
		const document = await vscode.workspace.openTextDocument({
			content: `${title}\n\n${report.output || 'No problems.\n'}`,
			language: 'plaintext',
		});
		await vscode.window.showTextDocument(document, { preview: true });
	}

	/** Runs `fn` with the view showing `label`, reporting a failure. */
	async withBusy(label: string, fn: () => Promise<unknown>): Promise<void> {
		this.busy = label;
		this.changed();
		try {
			await fn();
		} catch (e) {
			vscode.window.showErrorMessage(`Kernel: ${label} failed: ${(e as Error).message}`);
		} finally {
			this.busy = '';
			this.changed();
		}
	}
}

function readAndRemove(file: string): string {
	try {
		const text = fs.readFileSync(file, 'utf8');
		fs.rmSync(file, { force: true });
		return text;
	} catch {
		return '';
	}
}

/** A checkpatch result in words, and its class: '', 'ok', 'warn' or 'error'. */
export function summary(report: Report | undefined | null): { text: string; cls: string } {
	if (report === undefined) {
		return { text: 'not checked', cls: '' };
	}
	if (report === null) {
		return { text: 'no changes', cls: '' };
	}
	const parts: string[] = [];
	if (report.errors) {
		parts.push(`${report.errors} error${report.errors > 1 ? 's' : ''}`);
	}
	if (report.warnings) {
		parts.push(`${report.warnings} warning${report.warnings > 1 ? 's' : ''}`);
	}
	if (report.checks) {
		parts.push(`${report.checks} check${report.checks > 1 ? 's' : ''}`);
	}
	return {
		text: parts.join(', ') || 'clean',
		cls: report.errors ? 'error' : report.warnings || report.checks ? 'warn' : 'ok',
	};
}

/** The icon and colour of a checkpatch result. */
export function statusIcon(report: Report | undefined | null): {
	icon: string;
	color: string | undefined;
} {
	if (!report) {
		return { icon: 'git-commit', color: undefined };
	}
	if (report.errors) {
		return { icon: 'error', color: 'problemsErrorIcon.foreground' };
	}
	if (report.warnings || report.checks) {
		return { icon: 'warning', color: 'problemsWarningIcon.foreground' };
	}
	return { icon: 'pass', color: 'testing.iconPassed' };
}

/** What a click on a value row opens. */
const CLICK: Record<string, string> = {
	base: 'kernelWorkbench.series.pickBase',
	prefix: 'kernelWorkbench.series.editPrefix',
	cover: 'kernelWorkbench.series.editCover',
	edit: 'kernelWorkbench.editItem',
};

export interface SeriesItemOptions {
	description?: string;
	icon?: string;
	color?: string;
	tooltip?: string | vscode.MarkdownString;
	contextValue?: string;
	children?: SeriesItem[];
	collapsed?: boolean;
	command?: vscode.Command;
	/** A commit hash, 'working', or a file path. */
	id?: string;
	option?: OptionSpec;
}

/** A row of the Series view. */
export class SeriesItem extends vscode.TreeItem {
	readonly children?: SeriesItem[];
	/** A commit hash, 'working', or a file path. */
	readonly ref?: string;
	readonly option?: OptionSpec;

	constructor(label: string, o: SeriesItemOptions = {}) {
		super(
			label,
			o.children
				? o.collapsed
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None,
		);
		this.description = o.description;
		if (o.icon) {
			this.iconPath = new vscode.ThemeIcon(
				o.icon,
				o.color ? new vscode.ThemeColor(o.color) : undefined,
			);
		}
		this.tooltip = o.tooltip;
		this.contextValue = o.contextValue;
		this.children = o.children;
		if (o.command) {
			this.command = o.command;
		} else if (o.contextValue && CLICK[o.contextValue]) {
			this.command = { command: CLICK[o.contextValue], title: label, arguments: [this] };
		}
		this.ref = o.id;
		this.option = o.option;
	}
}

/** What Check series runs; edited like the Kernel view's options. */
export const CHECK_OPTIONS: OptionSpec[] = [
	{ key: 'checkpatch.strict', label: 'checkpatch --strict', kind: 'bool' },
	{
		key: 'checkpatch.ignore',
		label: 'checkpatch: ignored types',
		kind: 'words',
		placeholder: 'FILE_PATH_CHANGES LINUX_VERSION_CODE',
	},
	{ key: 'check.sparse', label: 'sparse (C=2)', kind: 'bool' },
	{ key: 'check.coccinelle', label: 'Coccinelle', kind: 'bool' },
];

/**
 * The Series view in the Kernel Git tab: the branch's commits over its base with their
 * checkpatch results.
 */
export class SeriesTree implements vscode.TreeDataProvider<SeriesItem> {
	/** The view, for its message and description. */
	view: { message?: string; description?: string } | undefined;
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/** The cover letter, read on refresh. */
	cover = '';

	constructor(
		readonly series: Series,
		readonly patches: Patches,
	) {
		series.onDidChange(() => this.refresh());
		series.settings.onDidChange(() => this.refresh());
	}

	async refresh(): Promise<void> {
		const se = this.series;
		this.cover = await this.patches.cover();
		vscode.commands.executeCommand(
			'setContext',
			'kernelWorkbench.patchesGenerated',
			!!this.patches.output,
		);
		vscode.commands.executeCommand(
			'setContext',
			'kernelWorkbench.seriesNoBase',
			!se.info.mergeBase,
		);
		vscode.commands.executeCommand('setContext', 'kernelWorkbench.seriesBusy', !!se.busy);
		if (this.view) {
			this.view.description = se.info.mergeBase
				? `${se.info.branch || 'detached HEAD'} · v${se.version}`
				: '';
			this.view.message = se.info.mergeBase && se.info.error ? se.info.error : undefined;
		}
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(item: SeriesItem): vscode.TreeItem {
		return item;
	}

	getChildren(item?: SeriesItem): SeriesItem[] {
		if (item) {
			return item.children ?? [];
		}
		const se = this.series;
		if (!se.info.mergeBase) {
			return []; // the welcome view: pick a base
		}
		const items: SeriesItem[] = [];
		if (se.busy) {
			items.push(new SeriesItem(se.busy, { icon: 'loading~spin' }));
		}
		items.push(this.actionsGroup());
		items.push(
			new SeriesItem('Base', {
				description: `${se.info.base} (${se.info.mergeBase.slice(0, 12)})`,
				icon: 'git-branch',
				contextValue: 'base',
			}),
			new SeriesItem('Version', {
				description: `v${se.version}`,
				icon: 'versions',
				contextValue: 'version',
			}),
		);
		items.push(this.commitsGroup());
		const working = summary(se.working);
		items.push(
			new SeriesItem('Working changes', {
				description: working.text,
				icon: se.working ? statusIcon(se.working).icon : 'edit',
				color: se.working ? statusIcon(se.working).color : undefined,
				id: 'working',
				contextValue: se.working ? 'workingChecked' : 'working',
			}),
		);
		if (se.lastBuild) {
			items.push(
				new SeriesItem('Build checks', {
					description: se.lastBuild,
					tooltip: se.lastBuild,
					icon: 'tools',
				}),
			);
		}
		items.push(this.optionsGroup(), ...this.extraGroups());
		return items;
	}

	/** The actions, as rows that run a command. */
	actions(): SeriesItem[] {
		const n = this.series.info.commits.length;
		const commits = n ? ` on ${n} commit${n > 1 ? 's' : ''}` : '';
		return [
			action(
				'Check series',
				'kernelWorkbench.series.check',
				'checklist',
				`checkpatch${commits} + build checks`,
			),
			action(
				'Check working changes',
				'kernelWorkbench.series.checkWorking',
				'edit',
				'checkpatch on uncommitted changes',
			),
			action(
				'Fill recipients',
				'kernelWorkbench.series.fillRecipients',
				'person-add',
				'To/Cc from get_maintainer.pl',
			),
			action(
				'Generate patches',
				'kernelWorkbench.series.generate',
				'package',
				'git format-patch',
			),
		];
	}

	/** Groups after Check options. */
	extraGroups(): SeriesItem[] {
		return [this.patchesGroup()];
	}

	/** What Generate patches will use. */
	patchesGroup(): SeriesItem {
		const pa = this.patches;
		const se = this.series;
		const children: SeriesItem[] = [
			new SeriesItem('Subject prefix', {
				description: `[${pa.prefix}]`,
				icon: 'symbol-string',
				contextValue: 'prefix',
			}),
		];
		if (se.info.commits.length > 1) {
			children.push(
				new SeriesItem('Cover letter', {
					description: this.cover ? this.cover.split('\n')[0] : 'not written yet',
					icon: this.cover ? 'mail' : 'warning',
					color: this.cover ? undefined : 'problemsWarningIcon.foreground',
					contextValue: 'cover',
					tooltip:
						this.cover ||
						'Stored as the git branch description; git format-patch uses it.',
				}),
			);
		}
		const addresses = (list: string[]) => list.map(a => new SeriesItem(a, { icon: 'person' }));
		children.push(
			new SeriesItem('To', {
				description: String(pa.to.length),
				icon: 'mail',
				contextValue: 'recipients',
				children: addresses(pa.to),
				collapsed: true,
			}),
			new SeriesItem('Cc', {
				description: String(pa.cc.length),
				icon: 'mail',
				contextValue: 'recipients',
				children: addresses(pa.cc),
				collapsed: true,
			}),
		);
		if (pa.output) {
			const dir = pa.output.dir;
			children.push(
				new SeriesItem('Generated', {
					description: path.relative(se.root, dir),
					icon: 'package',
					contextValue: 'generated',
					children: pa.output.files.map(
						f =>
							new SeriesItem(f, {
								icon: 'mail',
								id: path.join(dir, f),
								command: {
									command: 'vscode.open',
									title: 'Open',
									arguments: [vscode.Uri.file(path.join(dir, f))],
								},
							}),
					),
				}),
			);
		}
		return new SeriesItem('Patches', { icon: 'git-pull-request', children });
	}

	actionsGroup(): SeriesItem {
		return new SeriesItem('Actions', { icon: 'play-circle', children: this.actions() });
	}

	commitsGroup(): SeriesItem {
		const se = this.series;
		const n = se.info.commits.length;
		const rows = se.info.commits.map((c, i) => {
			const report = se.reports.get(c.hash);
			const status = statusIcon(report);
			const notes = report
				? report.findings.filter(f => !f.file).map(f => `- ${f.level}: ${f.message}`)
				: [];
			const tooltip = new vscode.MarkdownString(
				`**${md(c.subject)}**\n\n\`${c.short}\` · ${md(c.author)}\n\n` +
					(report
						? `checkpatch: ${summary(report).text}` +
							(notes.length ? `\n\n${notes.map(md).join('\n')}` : '')
						: 'Not checked yet.'),
			);
			return new SeriesItem(c.subject, {
				description: `${i + 1}/${n}${report ? ` · ${summary(report).text}` : ''}`,
				icon: status.icon,
				color: status.color,
				tooltip,
				id: c.hash,
				contextValue: report ? 'commitChecked' : 'commit',
				command: {
					command: 'kernelWorkbench.git.openCommit',
					title: 'Open Commit',
					arguments: [c.hash],
				},
			});
		});
		return new SeriesItem('Commits', {
			description: String(n),
			icon: 'git-commit',
			children: n
				? rows
				: [new SeriesItem('No commits on top of the base.', { icon: 'info' })],
		});
	}

	optionsGroup(): SeriesItem {
		const settings = this.series.settings;
		return new SeriesItem('Check options', {
			icon: 'settings',
			collapsed: true,
			children: CHECK_OPTIONS.map(option => {
				const value = settings.get<any>(option.key, undefined);
				return new SeriesItem(option.label, {
					description:
						option.kind === 'bool'
							? value
								? 'on'
								: 'off'
							: (value ?? []).join(' ') || 'none',
					tooltip: `kernelWorkbench.${option.key}`,
					contextValue: 'edit',
					option,
				});
			}),
		});
	}
}

/** A row that runs a command when clicked. */
export function action(
	label: string,
	command: string,
	icon: string,
	description: string,
): SeriesItem {
	return new SeriesItem(label, {
		icon,
		description,
		contextValue: 'action',
		tooltip: `Click to ${label.toLowerCase()}`,
		command: { command, title: label },
	});
}

function md(s: string): string {
	return s.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}

/** The Series view and its commands. */
export function registerSeries(
	context: vscode.ExtensionContext,
	settings: Settings,
): { series: Series; patches: Patches; view: SeriesTree } {
	const series = new Series(context, settings);
	const patches = new Patches(series);
	const tree = new SeriesTree(series, patches);
	const view = vscode.window.createTreeView('kernelWorkbench.series', {
		treeDataProvider: tree,
	});
	tree.view = view;
	const commands: [string, (...args: any[]) => unknown][] = [
		['kernelWorkbench.series.refresh', () => series.refresh()],
		['kernelWorkbench.series.checkWorking', () => series.checkWorking()],
		['kernelWorkbench.series.check', () => series.checkSeries()],
		['kernelWorkbench.series.format', () => series.formatChanged()],
		['kernelWorkbench.series.pickBase', () => series.pickBase()],
		['kernelWorkbench.series.nextVersion', () => series.setVersion(series.version + 1)],
		['kernelWorkbench.series.previousVersion', () => series.setVersion(series.version - 1)],
		['kernelWorkbench.series.editCover', () => patches.editCover()],
		['kernelWorkbench.series.editPrefix', () => patches.editPrefix()],
		['kernelWorkbench.series.editRecipients', () => patches.editRecipients()],
		[
			'kernelWorkbench.series.fillRecipients',
			() => series.withBusy('get_maintainer.pl', () => patches.fillRecipients()),
		],
		['kernelWorkbench.series.generate', () => patches.generate()],
		[
			'kernelWorkbench.series.revealOutput',
			() =>
				patches.output &&
				vscode.commands.executeCommand(
					'revealFileInOS',
					vscode.Uri.file(path.join(patches.output.dir, patches.output.files[0])),
				),
		],
		[
			'kernelWorkbench.series.report',
			(item?: SeriesItem) => item?.ref && series.showReport(item.ref),
		],
	];
	for (const [id, fn] of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	}
	context.subscriptions.push(
		view,
		series.problems.collection,
		view.onDidChangeVisibility(() => view.visible && series.refresh()),
	);
	series.refresh();
	return { series, patches, view: tree };
}
