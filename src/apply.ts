import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { exists, git, gitDir, gitStatus } from './git';
import type { OptionSpec } from './options';
import type { Settings } from './settings';

/** A series fetched (or loaded) and ready for git am. */
export interface Fetched {
	/** The mbox file to apply. */
	mbox: string;
	/** What it came from: a Message-ID or file names. */
	source: string;
	title: string;
	/** The subjects, in order. */
	patches: string[];
	/** The trailers b4 added from replies. */
	trailers: string[];
	/** The base-commit, when known. */
	base?: string;
	/** b4's account of the base. */
	baseNote: string;
	link?: string;
	/** b4's output. */
	log: string;
}

/** The state of a git am in progress (.git/rebase-apply). */
export interface AmState {
	next: number;
	last: number;
	subject: string;
	conflicts: string[];
}

/** The Message-ID in a lore or patch.msgid.link URL, or a bare Message-ID. */
export function messageId(input: string): string {
	const s = input.trim().replace(/^<|>$/g, '');
	const m = /^https?:\/\/[^/]+\/(?:[^/]+\/)?([^/?#]+@[^/?#]+)/.exec(s);
	return decodeURIComponent(m ? m[1] : s);
}

/** The subjects of the messages in an mbox. */
export function mboxSubjects(text: string): string[] {
	const subjects: string[] = [];
	for (const message of text.split(/^From [^\n]*\n/m).slice(1)) {
		const m = /^Subject: ((?:.*)(?:\n[ \t].*)*)/m.exec(message);
		if (m) {
			subjects.push(m[1].replace(/\n[ \t]+/g, ' ').trim());
		}
	}
	return subjects;
}

/** Fetching a series with b4, loading patch files, and git am with its conflicts. */
export class Apply {
	fetched: Fetched | undefined;
	am: AmState | undefined;
	busy = '';
	message = '';
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		readonly root: string,
	) {}

	changed(): void {
		this._onDidChange.fire();
	}

	/** Where fetched and loaded series are kept. */
	private storage(...parts: string[]): string {
		const base = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
		return path.join(base, ...parts);
	}

	/**
	 * Fetches a series from lore with b4 am: the latest version, the patches in order, the
	 * trailers from replies collected.
	 */
	async fetch(input: string, options: { link?: boolean; signoff?: boolean } = {}): Promise<void> {
		const msgid = messageId(input);
		if (!/@/.test(msgid)) {
			vscode.window.showErrorMessage(
				'Kernel: give a lore link or a Message-ID (it contains an @).',
			);
			return;
		}
		const dir = this.storage('lore', msgid.replace(/[^\w.@-]+/g, '_'));
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		const args = [
			'am',
			'-o',
			dir,
			...(options.link !== false ? ['-l'] : []),
			...(options.signoff ? ['-s'] : []),
			msgid,
		];
		this.busy = `b4 am ${msgid}`;
		this.message = '';
		this.changed();
		try {
			const { code, out } = await run('b4', args, this.root);
			const mbox = fs.readdirSync(dir).find(f => f.endsWith('.mbx'));
			if (code !== 0 || !mbox) {
				const reason = out.trim().split('\n').slice(-4).join('\n');
				throw new Error(reason || `b4 exited with ${code}`);
			}
			this.fetched = parseB4(out, path.join(dir, mbox), msgid);
			// The cover letter's subject names the series.
			const cover = fs.readdirSync(dir).find(f => f.endsWith('.cover'));
			if (cover) {
				const [subject] = mboxSubjects(fs.readFileSync(path.join(dir, cover), 'utf8'));
				if (subject) {
					this.fetched.title = subject;
				}
			}
		} catch (e) {
			this.fetched = undefined;
			this.message = `b4 am failed: ${(e as Error).message}`;
			if (/ENOENT/.test(this.message)) {
				this.message = 'b4 is not installed (Debian/Ubuntu: sudo apt install b4).';
			}
		} finally {
			this.busy = '';
			this.changed();
		}
	}

	/** Loads local .mbox or .patch files instead of fetching. */
	async openFiles(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			title: 'Patches to apply',
			canSelectMany: true,
			filters: {
				'Patches and mailboxes': ['patch', 'diff', 'mbox', 'mbx', 'eml'],
				'All files': ['*'],
			},
		});
		if (!uris?.length) {
			return;
		}
		const files = uris.map(u => u.fsPath).sort();
		const dir = this.storage('local');
		fs.mkdirSync(dir, { recursive: true });
		const mbox = path.join(dir, 'series.mbx');
		// git am takes several files, but one mbox keeps the rest simple; format-patch files
		// already start with a "From <hash>" line.
		fs.writeFileSync(
			mbox,
			files
				.map(f => {
					const text = fs.readFileSync(f, 'utf8');
					return /^From /.test(text)
						? text
						: `From kernel-workbench Mon Sep 17 00:00:00 2001\n${text}`;
				})
				.join('\n'),
		);
		const text = fs.readFileSync(mbox, 'utf8');
		const base = /^base-commit: ([0-9a-f]{7,40})/m.exec(text)?.[1];
		this.fetched = {
			mbox,
			source: files.map(f => path.basename(f)).join(', '),
			title: path.basename(files[0]),
			patches: mboxSubjects(text).filter(s => !/\b0+\/\d+\]/.test(s)),
			trailers: [],
			log: '',
			base,
			baseNote: base ? `base-commit ${base.slice(0, 12)} from the patches` : 'not specified',
		};
		if (base && !(await exists(this.root, base))) {
			this.fetched.baseNote += ' (not in this tree)';
		}
		this.message = '';
		this.changed();
	}

	/** git am -3 of the fetched series, on the current branch or a new one at the base. */
	async apply(where: 'current' | 'newBranch'): Promise<void> {
		const fetched = this.fetched;
		if (!fetched) {
			return;
		}
		if (await this.inProgress()) {
			vscode.window.showErrorMessage(
				'Kernel: a git am is already in progress; continue, skip or abort it first.',
			);
			return;
		}
		if (where === 'newBranch') {
			let base = fetched.base && (await exists(this.root, fetched.base)) ? fetched.base : '';
			if (!base) {
				const typed = await vscode.window.showInputBox({
					title: 'Base for the new branch',
					prompt: 'The series has no usable base-commit; give a commit or ref',
					value: 'HEAD',
				});
				if (!typed) {
					return;
				}
				base = typed;
			}
			const name = await vscode.window.showInputBox({
				title: 'New branch name',
				value: suggestBranch(fetched),
			});
			if (!name) {
				return;
			}
			const result = await gitStatus(this.root, ['checkout', '-b', name, base]);
			if (result.code !== 0) {
				vscode.window.showErrorMessage(
					`Kernel: git checkout -b failed: ${result.stderr.trim()}`,
				);
				return;
			}
		}
		this.busy = 'git am -3';
		this.changed();
		const result = await gitStatus(this.root, ['am', '-3', fetched.mbox]);
		this.busy = '';
		await this.refreshState();
		if (result.code === 0) {
			const n = fetched.patches.length;
			this.message = `Applied ${n} patch${n > 1 ? 'es' : ''}.`;
		} else {
			this.message = this.am
				? `git am stopped at patch ${this.am.next}/${this.am.last}: ${this.am.subject}`
				: `git am failed: ${lastLines(result.stderr || result.stdout)}`;
			await this.openConflicts();
		}
		this.changed();
	}

	async inProgress(): Promise<boolean> {
		return fs.existsSync(path.join(await gitDir(this.root), 'rebase-apply', 'applying'));
	}

	/** Reads the state of the git am in progress, if any. */
	async refreshState(): Promise<void> {
		const dir = path.join(await gitDir(this.root), 'rebase-apply');
		if (!(await this.inProgress())) {
			this.am = undefined;
			this.changed();
			return;
		}
		const read = (f: string) => readOr(path.join(dir, f));
		const next = +read('next') || 0;
		const last = +read('last') || 0;
		const message = read('final-commit') || read('msg');
		const out = await git(this.root, ['diff', '--name-only', '--diff-filter=U']);
		const conflicts = out.split('\n').filter(Boolean);
		this.am = { next, last, subject: message.split('\n')[0], conflicts };
		this.changed();
	}

	async openConflicts(): Promise<void> {
		for (const f of this.am?.conflicts ?? []) {
			await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root, f)), {
				preview: false,
			});
		}
	}

	/**
	 * git am --continue, --skip or --abort. Continue first stages the conflicted files, once
	 * they have no conflict markers left.
	 */
	async resolve(what: 'continue' | 'skip' | 'abort'): Promise<void> {
		if (what === 'continue' && this.am?.conflicts.length) {
			const unresolved = this.am.conflicts.filter(f =>
				/^(<{7}|>{7}|={7})( |$)/m.test(readOr(path.join(this.root, f))),
			);
			if (unresolved.length) {
				vscode.window.showErrorMessage(
					`Kernel: conflict markers left in ${unresolved.join(', ')}.`,
				);
				return;
			}
			await git(this.root, ['add', '--', ...this.am.conflicts]);
		}
		const result = await gitStatus(this.root, ['am', `--${what}`]);
		await this.refreshState();
		if (result.code === 0) {
			this.message = this.am
				? `Continuing: now at patch ${this.am.next}/${this.am.last}`
				: what === 'abort'
					? 'git am aborted; the branch is as before.'
					: 'All patches applied.';
		} else {
			this.message = `git am --${what}: ${lastLines(result.stderr || result.stdout)}`;
			if (this.am) {
				await this.openConflicts();
			}
		}
		this.changed();
	}
}

/** The series in b4 am's output. */
export function parseB4(out: string, mbox: string, msgid: string): Fetched {
	const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
	const patches = [...plain.matchAll(/^\s+(?:\S+ )?(\[[^\]]*PATCH[^\]]*\] .*)$/gm)].map(m =>
		m[1].trim(),
	);
	const trailers = [...plain.matchAll(/^\s+\+ (.+?)(?: \(.*\))?$/gm)]
		.map(m => m[1].trim())
		.filter(t => !/^Link:/.test(t));
	const baseLine = /^\s*Base: (.*)$/m.exec(plain)?.[1].trim() || 'not specified';
	const base = /([0-9a-f]{12,40})/.exec(baseLine)?.[1];
	const link = /^\s*Link: (\S+)/m.exec(plain)?.[1];
	return {
		mbox,
		source: msgid,
		title: patches[0] ?? path.basename(mbox),
		patches,
		trailers,
		...(base && !/not known|overriding/.test(baseLine) ? { base } : {}),
		baseNote: baseLine,
		...(link ? { link } : {}),
		log: plain,
	};
}

/** A branch name for reviewing the series. */
function suggestBranch(fetched: Fetched): string {
	const s = fetched.title
		.replace(/^\[[^\]]*\]\s*/, '')
		.replace(/^[\w/.-]+:\s*/, '')
		.toLowerCase();
	const slug = s
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
	return `review/${slug || 'series'}`;
}

function readOr(file: string): string {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

function lastLines(text: string): string {
	return text.trim().split('\n').slice(-3).join(' ');
}

/** Runs a command, resolving with its exit code and output; rejects when it is missing. */
function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			cmd,
			args,
			{ cwd, maxBuffer: 64 << 20, env: { ...process.env, NO_COLOR: '1' } },
			(error, stdout, stderr) => {
				if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
					reject(error);
					return;
				}
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
				resolve({ code, out: `${stdout}${stderr}` });
			},
		);
	});
}

export interface ApplyItemOptions {
	description?: string;
	icon?: string;
	color?: string;
	tooltip?: string;
	contextValue?: string;
	children?: ApplyItem[];
	collapsed?: boolean;
	command?: vscode.Command;
	option?: OptionSpec;
}

/** A row of the Apply view. */
export class ApplyItem extends vscode.TreeItem {
	readonly children?: ApplyItem[];
	readonly option?: OptionSpec;

	constructor(label: string, o: ApplyItemOptions = {}) {
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
		this.option = o.option;
		if (o.command) {
			this.command = o.command;
		} else if (o.contextValue === 'edit') {
			this.command = {
				command: 'kernelWorkbench.editItem',
				title: 'Change…',
				arguments: [this],
			};
		}
	}
}

/** What fetching with b4 adds; edited like the Kernel view's options. */
export const FETCH_OPTIONS: OptionSpec[] = [
	{ key: 'apply.addLink', label: 'Add Link: trailers', kind: 'bool' },
	{ key: 'apply.addSignoff', label: 'Add my Signed-off-by', kind: 'bool' },
];

/** The Apply view in the Kernel Git tab: the fetched series, and a git am in progress. */
export class ApplyTree implements vscode.TreeDataProvider<ApplyItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		readonly apply: Apply,
		private readonly settings: Settings,
	) {
		apply.onDidChange(() => this.refresh());
		settings.onDidChange(() => this.refresh());
	}

	refresh(): void {
		const a = this.apply;
		const set = (key: string, value: boolean) =>
			vscode.commands.executeCommand('setContext', `kernelWorkbench.${key}`, value);
		set('applyFetched', !!a.fetched);
		set('amInProgress', !!a.am);
		set('applyEmpty', !a.fetched && !a.am && !a.busy && !a.message);
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(item: ApplyItem): vscode.TreeItem {
		return item;
	}

	getChildren(item?: ApplyItem): ApplyItem[] {
		if (item) {
			return item.children ?? [];
		}
		const a = this.apply;
		const items: ApplyItem[] = [];
		if (a.busy) {
			items.push(new ApplyItem(a.busy, { icon: 'loading~spin' }));
		}
		if (a.am || a.fetched) {
			items.push(new ApplyItem('Actions', { icon: 'play-circle', children: this.actions() }));
		}
		if (a.am) {
			items.push(this.amItem(a.am));
		}
		const f = a.fetched;
		if (f) {
			const prefix = /^\[([^\]]*)\]/.exec(f.title)?.[1] ?? '';
			items.push(
				new ApplyItem(f.title.replace(/^\[[^\]]*\]\s*/, ''), {
					description: prefix,
					icon: 'git-pull-request',
					tooltip: `${f.title}\n${f.source}`,
					children: f.patches.map(
						p =>
							new ApplyItem(p.replace(/^\[[^\]]*\]\s*/, ''), {
								icon: 'git-commit',
								description: /^\[[^\]]*?(\d+\/\d+)\]/.exec(p)?.[1] ?? '',
							}),
					),
				}),
				new ApplyItem('Base', {
					description: f.baseNote,
					icon: 'git-branch',
					tooltip: f.baseNote,
				}),
				new ApplyItem('Trailers collected', {
					description: String(f.trailers.length),
					icon: 'tag',
					children: f.trailers.map(t => new ApplyItem(t, { icon: 'person' })),
					collapsed: true,
				}),
				new ApplyItem('mbox', {
					description: path.basename(f.mbox),
					icon: 'file',
					command: {
						command: 'vscode.open',
						title: 'Open',
						arguments: [vscode.Uri.file(f.mbox)],
					},
				}),
			);
		}
		if (a.message) {
			items.push(
				new ApplyItem(a.message, {
					icon: /fail|error|not installed/i.test(a.message) ? 'error' : 'info',
					tooltip: a.message,
				}),
			);
		}
		if (items.length) {
			items.push(this.optionsGroup());
		}
		return items;
	}

	/** The actions, as rows that run a command. */
	actions(): ApplyItem[] {
		const act = (label: string, command: string, icon: string, description: string) =>
			new ApplyItem(label, {
				icon,
				description,
				contextValue: 'action',
				tooltip: `Click to ${label.toLowerCase()}`,
				command: { command, title: label },
			});
		return this.apply.am
			? [
					act(
						'Continue',
						'kernelWorkbench.apply.continue',
						'debug-continue',
						'git am --continue (after resolving)',
					),
					act(
						'Skip this patch',
						'kernelWorkbench.apply.skip',
						'debug-step-over',
						'git am --skip',
					),
					act('Abort', 'kernelWorkbench.apply.abort', 'close', 'git am --abort'),
				]
			: [
					act(
						'Apply to current branch',
						'kernelWorkbench.apply.applyCurrent',
						'check',
						'git am -3',
					),
					act(
						'Apply on new branch…',
						'kernelWorkbench.apply.applyNewBranch',
						'git-branch',
						'new branch at the base, then git am -3',
					),
					act(
						'Fetch another series…',
						'kernelWorkbench.apply.fetch',
						'cloud-download',
						'b4 am from lore',
					),
				];
	}

	/** The stopped git am, with its conflicted files. */
	amItem(am: AmState): ApplyItem {
		return new ApplyItem(`git am stopped at patch ${am.next}/${am.last}`, {
			description: am.subject,
			icon: 'warning',
			color: 'problemsWarningIcon.foreground',
			tooltip: 'Resolve the conflicts, then Continue; or Skip this patch, or Abort.',
			children: am.conflicts.length
				? am.conflicts.map(
						f =>
							new ApplyItem(f, {
								icon: 'diff',
								command: {
									command: 'vscode.open',
									title: 'Open',
									arguments: [vscode.Uri.file(path.join(this.apply.root, f))],
								},
							}),
					)
				: [
						new ApplyItem(
							'No conflicted files: the patch did not apply at all. ' +
								'Skip it or abort.',
							{ icon: 'info' },
						),
					],
		});
	}

	optionsGroup(): ApplyItem {
		return new ApplyItem('Fetch options', {
			icon: 'settings',
			collapsed: true,
			children: FETCH_OPTIONS.map(
				option =>
					new ApplyItem(option.label, {
						description: this.settings.get(option.key, option.key === 'apply.addLink')
							? 'on'
							: 'off',
						contextValue: 'edit',
						option,
						tooltip: `kernelWorkbench.${option.key}`,
					}),
			),
		});
	}
}

/** The Apply view and its commands. */
export function registerApply(
	context: vscode.ExtensionContext,
	settings: Settings,
): { apply: Apply; view: ApplyTree } {
	const apply = new Apply(context, settings.root);
	const tree = new ApplyTree(apply, settings);
	const fetch = async () => {
		const input = await vscode.window.showInputBox({
			title: 'Fetch a series from lore',
			prompt: 'lore link or Message-ID',
			placeHolder: 'https://lore.kernel.org/r/… or 20260917233222.2542500-2-memxor@gmail.com',
		});
		if (!input) {
			return;
		}
		await vscode.commands.executeCommand('kernelWorkbench.apply.focus');
		await apply.fetch(input, {
			link: settings.get('apply.addLink', true),
			signoff: settings.get('apply.addSignoff', false),
		});
	};
	const commands: [string, (...args: any[]) => unknown][] = [
		['kernelWorkbench.apply.fetch', fetch],
		['kernelWorkbench.apply.openFiles', () => apply.openFiles()],
		['kernelWorkbench.apply.applyCurrent', () => apply.apply('current')],
		['kernelWorkbench.apply.applyNewBranch', () => apply.apply('newBranch')],
		['kernelWorkbench.apply.continue', () => apply.resolve('continue')],
		['kernelWorkbench.apply.skip', () => apply.resolve('skip')],
		['kernelWorkbench.apply.abort', () => apply.resolve('abort')],
		[
			'kernelWorkbench.apply.showLog',
			async () => {
				if (!apply.fetched) {
					return;
				}
				const document = await vscode.workspace.openTextDocument({
					content: apply.fetched.log,
					language: 'plaintext',
				});
				await vscode.window.showTextDocument(document, { preview: true });
			},
		],
		[
			'kernelWorkbench.apply.openLink',
			() =>
				apply.fetched?.link &&
				vscode.env.openExternal(vscode.Uri.parse(apply.fetched.link)),
		],
		[
			'kernelWorkbench.apply.clear',
			() => {
				apply.fetched = undefined;
				apply.message = '';
				apply.changed();
			},
		],
	];
	const view = vscode.window.createTreeView('kernelWorkbench.apply', { treeDataProvider: tree });
	for (const [id, fn] of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	}
	context.subscriptions.push(
		view,
		view.onDidChangeVisibility(() => view.visible && apply.refreshState()),
	);
	apply.refreshState();
	tree.refresh();
	return { apply, view: tree };
}
