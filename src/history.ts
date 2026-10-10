import * as vscode from 'vscode';
import * as path from 'path';
import { blobUri, openCommit, SCHEME, toggleCommitView } from './commits';
import { fixesLine, git, log, relative } from './git';
import type { Commit } from './git';

/** Commits listed per page. */
const PAGE = 200;

/** What the view shows: a file (relative to the tree), or a 1-based inclusive line range. */
export type Target =
	{ kind: 'file'; file: string } | { kind: 'lines'; file: string; start: number; end: number };

/** A row of the File History view. */
export class HistoryItem extends vscode.TreeItem {
	readonly commit?: Commit;
	/** The next older commit (which knows the file's name before a rename). */
	readonly older?: Commit;
	/** The file's path in the commit. */
	readonly file?: string;

	constructor(label: string, data: { commit?: Commit; older?: Commit; file?: string } = {}) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.commit = data.commit;
		this.older = data.older;
		this.file = data.file;
	}
}

/**
 * The File History view: every commit that touched the file in the active editor
 * (following renames), or the history of a line range.
 */
export class FileHistory implements vscode.TreeDataProvider<HistoryItem> {
	target: Target | undefined;
	commits: Commit[] = [];
	filter = '';
	loading = false;
	/** Whether another page may follow. */
	more = false;
	error = '';
	/** The view, for its message and description. */
	view: { message?: string; description?: string } | undefined;
	private generation = 0;
	private cancel: vscode.CancellationTokenSource | undefined;
	private readonly nameCache = new Map<string, string[]>();
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly root: string) {}

	/** Shows the editor's file; commit tabs, output panels and such keep the current history. */
	followEditor(editor: vscode.TextEditor | undefined): void {
		if (!editor || editor.document.uri.scheme !== 'file') {
			return;
		}
		const file = relative(this.root, editor.document.uri.fsPath);
		if (!file || (this.target?.kind === 'file' && this.target.file === file)) {
			return;
		}
		this.show({ kind: 'file', file });
	}

	show(target: Target): void {
		this.target = target;
		this.filter = '';
		this.reload();
	}

	setFilter(filter: string): void {
		this.filter = filter.trim();
		this.reload();
	}

	reload(): void {
		this.commits = [];
		this.more = false;
		this.load();
	}

	/** Loads the next page (or the filtered or line history), cancelling an earlier load. */
	async load(): Promise<void> {
		const target = this.target;
		if (!target) {
			this.refresh();
			return;
		}
		this.cancel?.cancel();
		const cancel = (this.cancel = new vscode.CancellationTokenSource());
		const generation = ++this.generation;
		this.loading = true;
		this.error = '';
		this.refresh();
		try {
			let commits: Commit[];
			if (target.kind === 'lines') {
				commits = await log(
					this.root,
					['-s', `-L${target.start},${target.end}:${target.file}`],
					{ cancel: cancel.token },
				);
				this.more = false;
			} else if (this.filter) {
				// --follow only learns a file's older name when it walks past the rename, which
				// a --grep filter can hide; so filter over all the names the file has had.
				// git ANDs --grep (the whole message) and --author; either should match.
				const names = await this.names(target.file, cancel.token);
				const options = { paths: names, names: true, cancel: cancel.token };
				const [bySubject, byAuthor] = await Promise.all([
					log(this.root, ['-i', `--grep=${this.filter}`, '-n', '500'], options),
					log(this.root, ['-i', `--author=${this.filter}`, '-n', '500'], options),
				]);
				const seen = new Set<string>();
				commits = [...bySubject, ...byAuthor]
					.filter(c => !seen.has(c.hash) && seen.add(c.hash))
					.sort((a, b) => b.date.localeCompare(a.date));
				this.more = false;
			} else {
				commits = await log(
					this.root,
					['--follow', '-n', String(PAGE), '--skip', String(this.commits.length)],
					{ paths: [target.file], names: true, cancel: cancel.token },
				);
				this.more = commits.length === PAGE;
			}
			if (generation !== this.generation) {
				return;
			}
			this.commits.push(...commits);
		} catch (e) {
			if (generation !== this.generation) {
				return;
			}
			this.error = (e as Error).message;
		}
		this.loading = false;
		this.refresh();
	}

	/** Every name a file has had (git log --follow), cached per file. */
	async names(file: string, cancel: vscode.CancellationToken): Promise<string[]> {
		const cached = this.nameCache.get(file);
		if (cached) {
			return cached;
		}
		const args = ['log', '--follow', '--name-only', '--format=', '--', file];
		const out = await git(this.root, args, { cancel });
		const names = [
			...new Set([
				file,
				...out
					.split('\n')
					.map(l => l.trim())
					.filter(Boolean),
			]),
		];
		this.nameCache.set(file, names);
		return names;
	}

	refresh(): void {
		if (this.view) {
			const t = this.target;
			this.view.message = !t
				? 'Open a file in the kernel tree to see its history.'
				: t.kind === 'lines'
					? `Lines ${t.start}–${t.end} of ${t.file}`
					: this.filter
						? `${t.file}: matching “${this.filter}”`
						: t.file;
			this.view.description = this.commits.length
				? `${this.commits.length}${this.more ? '+' : ''} commits`
				: '';
		}
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(item: HistoryItem): vscode.TreeItem {
		return item;
	}

	getChildren(): HistoryItem[] {
		const t = this.target;
		if (!t) {
			return [];
		}
		const items = this.commits.map((c, i) => {
			const item = new HistoryItem(c.subject, {
				commit: c,
				older: this.commits[i + 1],
				file: c.path ?? t.file,
			});
			item.description = `${c.short} · ${c.author} · ${c.date.slice(0, 10)}`;
			item.tooltip = new vscode.MarkdownString(
				`**${md(c.subject)}**\n\n${md(c.author)} <${md(c.email)}>  \n` +
					`${c.date.replace('T', ' ')}  \n\`${c.hash}\`` +
					(c.path && c.path !== t.file ? `  \nfile was ${md(c.path)}` : ''),
			);
			item.iconPath = new vscode.ThemeIcon('git-commit');
			item.contextValue = 'commit';
			item.command = {
				command: 'kernelWorkbench.git.openCommit',
				title: 'Open Commit',
				arguments: [c.hash, item.file],
			};
			return item;
		});
		if (this.loading) {
			const item = new HistoryItem('Loading history…');
			item.iconPath = new vscode.ThemeIcon('loading~spin');
			items.push(item);
		} else if (this.error) {
			const item = new HistoryItem(this.error.split('\n')[0]);
			item.iconPath = new vscode.ThemeIcon('error');
			item.tooltip = this.error;
			items.push(item);
		} else if (this.more) {
			const item = new HistoryItem(`Load ${PAGE} more…`);
			item.iconPath = new vscode.ThemeIcon('fold-down');
			item.command = { command: 'kernelWorkbench.history.loadMore', title: 'Load more' };
			items.push(item);
		} else if (!this.commits.length) {
			items.push(
				new HistoryItem(
					this.filter ? 'No matching commits.' : 'No commits (file not tracked?).',
				),
			);
		}
		return items;
	}
}

/** Escapes Markdown. */
function md(s: string): string {
	return s.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}

/**
 * The commit to act on: the row a context-menu command was invoked on, or the commit open
 * in the active editor.
 */
function commitArg(item: HistoryItem | undefined): string | undefined {
	if (item?.commit) {
		return item.commit.hash;
	}
	const uri = vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === SCHEME && uri.path.split('/')[1] !== 'blob'
		? uri.path.split('/')[2]
		: undefined;
}

/** Opens the commit's Link: on lore, or searches lore for its subject when it has none. */
export async function openOnLore(root: string, hash: string): Promise<void> {
	const message = await git(root, ['log', '-1', '--format=%B', hash]);
	const links = [...message.matchAll(/^Link:\s*(https?:\/\/\S+)/gim)].map(m => m[1]);
	let url = links.find(l => l.includes('lore.kernel.org')) ?? links[0];
	if (links.length > 1) {
		const pick = await vscode.window.showQuickPick(links, { title: 'Open which Link:?' });
		if (!pick) {
			return;
		}
		url = pick;
	}
	if (!url) {
		const subject = message.split('\n')[0];
		const choice = await vscode.window.showInformationMessage(
			'Kernel: this commit has no Link: tag. Search lore for its subject?',
			'Search lore',
		);
		if (!choice) {
			return;
		}
		url = `https://lore.kernel.org/all/?q=${encodeURIComponent(`s:"${subject}"`)}`;
	}
	await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** The File History view and its commands. */
export function registerHistory(context: vscode.ExtensionContext, root: string): FileHistory {
	const history = new FileHistory(root);
	const view = vscode.window.createTreeView('kernelWorkbench.history', {
		treeDataProvider: history,
	});
	history.view = view;
	history.followEditor(vscode.window.activeTextEditor);

	/** A file of the tree: the Uri's, or the active editor's. */
	const fileOf = (uri: vscode.Uri | undefined) => {
		const u = uri ?? vscode.window.activeTextEditor?.document.uri;
		return u && u.scheme === 'file' ? relative(root, u.fsPath) : undefined;
	};
	const activeUri = () => vscode.window.activeTextEditor?.document.uri;

	const commands: [string, (...args: any[]) => unknown][] = [
		[
			'kernelWorkbench.git.openCommit',
			(hash: string, file?: string) => openCommit(root, hash, { file }),
		],
		[
			'kernelWorkbench.git.commitWhole',
			(uri?: vscode.Uri) => toggleCommitView(uri ?? activeUri(), false),
		],
		[
			'kernelWorkbench.git.commitFileOnly',
			(uri?: vscode.Uri) => toggleCommitView(uri ?? activeUri(), true),
		],
		[
			'kernelWorkbench.history.showFile',
			async (uri?: vscode.Uri) => {
				const file = fileOf(uri);
				if (!file) {
					vscode.window.showWarningMessage('Kernel: open a file inside the kernel tree.');
					return;
				}
				history.show({ kind: 'file', file });
				await vscode.commands.executeCommand('kernelWorkbench.history.focus');
			},
		],
		[
			'kernelWorkbench.history.showLines',
			async () => {
				const editor = vscode.window.activeTextEditor;
				const file = editor && fileOf(editor.document.uri);
				if (!editor || !file) {
					vscode.window.showWarningMessage(
						'Kernel: select lines in a file inside the kernel tree.',
					);
					return;
				}
				if (editor.document.isDirty) {
					vscode.window.showWarningMessage(
						'Kernel: the file has unsaved changes; ' +
							'line numbers are matched against the last commit.',
					);
				}
				const selection = editor.selection;
				const end =
					selection.end.character === 0 && selection.end.line > selection.start.line
						? selection.end.line
						: selection.end.line + 1;
				history.show({ kind: 'lines', file, start: selection.start.line + 1, end });
				await vscode.commands.executeCommand('kernelWorkbench.history.focus');
			},
		],
		['kernelWorkbench.history.loadMore', () => history.load()],
		['kernelWorkbench.history.refresh', () => history.reload()],
		[
			'kernelWorkbench.history.filter',
			async () => {
				const text = await vscode.window.showInputBox({
					title: 'Filter history by commit message or author',
					value: history.filter,
				});
				if (text !== undefined) {
					history.setFilter(text);
				}
			},
		],
		['kernelWorkbench.history.clearFilter', () => history.setFilter('')],
		[
			'kernelWorkbench.git.copyHash',
			async (item?: HistoryItem) => {
				const hash = commitArg(item);
				if (hash) {
					await vscode.env.clipboard.writeText(hash);
				}
			},
		],
		[
			'kernelWorkbench.git.copyFixes',
			async (item?: HistoryItem) => {
				const hash = commitArg(item);
				if (!hash) {
					return;
				}
				const line = await fixesLine(root, hash);
				await vscode.env.clipboard.writeText(line);
				vscode.window.showInformationMessage(`Copied: ${line}`);
			},
		],
		[
			'kernelWorkbench.git.openAtCommit',
			async (item?: HistoryItem) => {
				if (!item?.commit || !item.file) {
					return;
				}
				const document = await vscode.workspace.openTextDocument(
					blobUri(item.commit.hash, item.file),
				);
				await vscode.window.showTextDocument(document, { preview: false });
			},
		],
		[
			'kernelWorkbench.git.compareWithPrevious',
			async (item?: HistoryItem) => {
				if (!item?.commit || !item.file) {
					return;
				}
				// The older history entry knows the file's name before a rename.
				const before = item.older?.path ?? item.file;
				const short = item.commit.short;
				await vscode.commands.executeCommand(
					'vscode.diff',
					blobUri(`${item.commit.hash}^`, before),
					blobUri(item.commit.hash, item.file),
					`${path.basename(item.file)} (${short}^ ↔ ${short})`,
				);
			},
		],
		[
			'kernelWorkbench.git.openOnLore',
			async (item?: HistoryItem) => {
				const hash = commitArg(item);
				if (hash) {
					await openOnLore(root, hash);
				}
			},
		],
	];
	for (const [id, fn] of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	}
	context.subscriptions.push(
		view,
		vscode.window.onDidChangeActiveTextEditor(editor => history.followEditor(editor)),
	);
	return history;
}
