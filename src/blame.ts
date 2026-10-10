import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { blobUri, SCHEME } from './commits';
import { fixesLine, git, log, mapLine, relative } from './git';
import type { Cancel, Commit } from './git';
import { openOnLore } from './history';

const UNCOMMITTED = /^0{40}$/;

/** One line of git blame --porcelain output. */
export interface BlameLine {
	hash: string;
	/** The line's number in that commit's version of the file. */
	origLine: number;
	/** The line's number in the blamed version. */
	finalLine: number;
	author: string;
	email: string;
	/** Seconds since the epoch. */
	time: number;
	summary: string;
	/** The file's name in that commit. */
	filename: string;
	/** The parent, and the file's name there. */
	previous?: { hash: string; file: string };
	/** The line's content. */
	text: string;
}

/** The lines of git blame --porcelain output, indexed by finalLine - 1. */
export function parsePorcelain(out: string): BlameLine[] {
	const commits = new Map<string, Record<string, any>>();
	const lines: BlameLine[] = [];
	let current: { info: Record<string, any>; origLine: number; finalLine: number } | undefined;
	for (const line of out.split('\n')) {
		const head = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
		if (head) {
			const info = commits.get(head[1]) ?? { hash: head[1] };
			commits.set(head[1], info);
			current = { info, origLine: +head[2], finalLine: +head[3] };
			continue;
		}
		if (!current) {
			continue;
		}
		if (line.startsWith('\t')) {
			const i = current.info;
			lines[current.finalLine - 1] = {
				hash: i.hash,
				origLine: current.origLine,
				finalLine: current.finalLine,
				author: i.author ?? '',
				email: (i['author-mail'] ?? '').replace(/^<|>$/g, ''),
				time: +(i['author-time'] ?? 0),
				summary: i.summary ?? '',
				filename: i.filename ?? '',
				previous: i.previous,
				text: line.slice(1),
			};
			continue;
		}
		const space = line.indexOf(' ');
		const key = space < 0 ? line : line.slice(0, space);
		const value = space < 0 ? '' : line.slice(space + 1);
		if (key === 'previous') {
			const [hash, ...file] = value.split(' ');
			current.info.previous = { hash, file: file.join(' ') };
		} else {
			current.info[key] = value;
		}
	}
	return lines;
}

/**
 * What to blame: a working-tree file (possibly with unsaved edits), or a file as of a
 * revision (a kernel-git blob tab).
 */
export interface BlameSource {
	/** Relative to the tree. */
	file: string;
	rev?: string;
	/** Unsaved text, blamed in place of the file. */
	contents?: string;
}

/** The blame source of a document, or undefined for one outside the tree. */
export function sourceOf(document: vscode.TextDocument, root: string): BlameSource | undefined {
	if (document.uri.scheme === 'file') {
		const file = relative(root, document.uri.fsPath);
		if (!file) {
			return undefined;
		}
		return { file, contents: document.isDirty ? document.getText() : undefined };
	}
	if (document.uri.scheme === SCHEME) {
		const [, kind, rev, ...rest] = document.uri.path.split('/');
		return kind === 'blob' ? { file: rest.join('/'), rev } : undefined;
	}
	return undefined;
}

/** git blame of the source; `line` (1-based) blames only that line. */
export async function blame(
	root: string,
	source: BlameSource,
	options: { line?: number; cancel?: Cancel } = {},
): Promise<BlameLine[]> {
	const cfg = vscode.workspace.getConfiguration('kernelWorkbench', vscode.Uri.file(root));
	const args = ['blame', '--porcelain'];
	if (cfg.get('blame.ignoreWhitespace', true)) {
		args.push('-w');
	}
	if (cfg.get('blame.detectMoves', false)) {
		args.push('-M', '-C');
	}
	if (fs.existsSync(path.join(root, '.git-blame-ignore-revs'))) {
		args.push('--ignore-revs-file', '.git-blame-ignore-revs');
	}
	if (options.line) {
		args.push('-L', `${options.line},${options.line}`);
	}
	if (source.contents !== undefined) {
		args.push('--contents', '-');
	}
	if (source.rev) {
		args.push(source.rev);
	}
	args.push('--', source.file);
	const out = await git(root, args, { input: source.contents, cancel: options.cancel });
	return parsePorcelain(out);
}

/** A date from seconds since the epoch. */
function day(time: number): string {
	return time ? new Date(time * 1000).toISOString().slice(0, 10) : '';
}

/** A Markdown hover for a blamed line, with command links. */
function hoverFor(b: BlameLine): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.isTrusted = true;
	if (UNCOMMITTED.test(b.hash)) {
		md.appendMarkdown('**Not committed yet**');
		return md;
	}
	const cmd = (id: string, args: unknown[]) =>
		`command:${id}?${encodeURIComponent(JSON.stringify(args))}`;
	md.appendMarkdown(
		`**${escapeMd(b.summary)}**\n\n${escapeMd(b.author)} <${escapeMd(b.email)}> · ` +
			`${day(b.time)} · \`${b.hash.slice(0, 12)}\`\n\n`,
	);
	md.appendMarkdown(
		`[Open commit](${cmd('kernelWorkbench.git.openCommit', [b.hash, b.filename])}) · `,
	);
	if (b.previous) {
		const args = [b.previous.hash, b.previous.file, b.origLine, b.hash, b.filename];
		md.appendMarkdown(
			`[Blame before this commit](${cmd('kernelWorkbench.blame.before', args)}) · `,
		);
	}
	const fixes = cmd('kernelWorkbench.git.copyFixes', [{ commit: { hash: b.hash } }]);
	md.appendMarkdown(`[Copy Fixes: line](${fixes})`);
	return md;
}

function escapeMd(s: string): string {
	return s.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}

/**
 * Blame annotations in the editor: hash, date and author before each line, once per run of
 * lines from the same commit. They are inlay hints rather than decorations because inlay
 * hint parts can be clickable: clicking the hash opens the commit. Hovering shows the
 * commit with more links.
 */
export class BlameAnnotations implements vscode.InlayHintsProvider {
	/** The documents with blame turned on, by Uri. */
	private readonly blamed = new Map<string, { source: BlameSource; lines: BlameLine[] }>();
	private readonly on = new Set<string>();
	private readonly pending = new Map<string, NodeJS.Timeout>();
	private readonly _onDidChangeInlayHints = new vscode.EventEmitter<void>();
	readonly onDidChangeInlayHints = this._onDidChangeInlayHints.event;

	constructor(private readonly root: string) {}

	async toggle(editor: vscode.TextEditor): Promise<void> {
		const key = editor.document.uri.toString();
		if (this.on.has(key)) {
			this.on.delete(key);
			this.blamed.delete(key);
			this._onDidChangeInlayHints.fire();
		} else {
			this.on.add(key);
			await this.render(editor);
		}
		vscode.commands.executeCommand('setContext', 'kernelWorkbench.blameOn', this.on.has(key));
	}

	isOn(editor: vscode.TextEditor): boolean {
		return this.on.has(editor.document.uri.toString());
	}

	async render(editor: vscode.TextEditor): Promise<void> {
		const key = editor.document.uri.toString();
		const source = sourceOf(editor.document, this.root);
		if (!source) {
			vscode.window.showWarningMessage('Kernel: blame works on files in the kernel tree.');
			this.on.delete(key);
			return;
		}
		let lines: BlameLine[];
		try {
			lines = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: 'git blame' },
				() => blame(this.root, source),
			);
		} catch (e) {
			vscode.window.showErrorMessage(`Kernel: git blame failed: ${(e as Error).message}`);
			this.on.delete(key);
			return;
		}
		if (!this.on.has(key)) {
			return;
		}
		this.blamed.set(key, { source, lines });
		this._onDidChangeInlayHints.fire();
	}

	provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
		const entry = this.blamed.get(document.uri.toString());
		if (!entry) {
			return [];
		}
		const { lines } = entry;
		const width = 36;
		const hints: vscode.InlayHint[] = [];
		const last = Math.min(range.end.line, lines.length - 1);
		for (let i = range.start.line; i <= last; i++) {
			const b = lines[i];
			if (!b) {
				continue;
			}
			const first = i === 0 || !lines[i - 1] || lines[i - 1].hash !== b.hash;
			const parts: vscode.InlayHintLabelPart[] = [];
			if (!first) {
				parts.push(new vscode.InlayHintLabelPart(' '.repeat(width)));
			} else if (UNCOMMITTED.test(b.hash)) {
				parts.push(new vscode.InlayHintLabelPart('not committed yet'.padEnd(width, ' ')));
			} else {
				const hash = new vscode.InlayHintLabelPart(b.hash.slice(0, 8));
				hash.command = {
					command: 'kernelWorkbench.git.openCommit',
					title: 'Open commit',
					arguments: [b.hash, b.filename],
				};
				hash.tooltip = hoverFor(b);
				let rest = ` ${day(b.time)} ${b.author}`;
				rest =
					rest.length > width - 8
						? rest.slice(0, width - 9) + '…'
						: rest.padEnd(width - 8, ' ');
				const restPart = new vscode.InlayHintLabelPart(rest);
				restPart.tooltip = hoverFor(b);
				parts.push(hash, restPart);
			}
			const hint = new vscode.InlayHint(new vscode.Position(i, 0), parts);
			hint.paddingRight = true;
			hints.push(hint);
		}
		return hints;
	}

	/** Re-blames after edits (with the unsaved text, so that the lines stay aligned). */
	changed(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		if (!this.on.has(key)) {
			return;
		}
		clearTimeout(this.pending.get(key));
		this.pending.set(
			key,
			setTimeout(() => {
				for (const editor of vscode.window.visibleTextEditors) {
					if (editor.document.uri.toString() === key) {
						this.render(editor);
					}
				}
			}, 800),
		);
	}
}

/** A row of the Blame view. */
export class BlameItem extends vscode.TreeItem {
	readonly commit?: Commit;
	readonly line?: BlameLine;
	readonly children?: BlameItem[];

	constructor(
		label: string,
		data: { commit?: Commit; line?: BlameLine; children?: BlameItem[] } = {},
	) {
		super(
			label,
			data.children
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None,
		);
		this.commit = data.commit;
		this.line = data.line;
		this.children = data.children;
	}
}

type State = 'idle' | 'blame' | 'chain' | 'done' | 'error';

/**
 * The Blame view: for the line under the cursor, the commit that last changed it and the
 * chain of earlier commits that changed it (git log -L), so that a whitespace fix or a
 * refactor can be walked past to the commit that introduced the line.
 */
export class BlameView implements vscode.TreeDataProvider<BlameItem> {
	at: { source: BlameSource; line: number; text: string } | undefined;
	blamed: BlameLine | undefined;
	chain: Commit[] | undefined;
	state: State = 'idle';
	error = '';
	/** The view, for its visibility and message. */
	view: { visible: boolean; message?: string } | undefined;
	private generation = 0;
	private cancel: vscode.CancellationTokenSource | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly root: string) {}

	/** Shows the line under the editor's cursor, a moment after it settles. */
	follow(editor: vscode.TextEditor | undefined): void {
		if (!editor || !this.view?.visible) {
			return;
		}
		const source = sourceOf(editor.document, this.root);
		if (!source) {
			return;
		}
		const line = editor.selection.active.line + 1;
		const at = this.at;
		if (
			at &&
			at.line === line &&
			at.source.file === source.file &&
			at.source.rev === source.rev &&
			!source.contents
		) {
			return;
		}
		clearTimeout(this.timer);
		const text = editor.document.lineAt(line - 1).text.trim();
		this.timer = setTimeout(() => this.update(source, line, text), 300);
	}

	async update(source: BlameSource, line: number, text: string): Promise<void> {
		this.cancel?.cancel();
		const cancel = (this.cancel = new vscode.CancellationTokenSource());
		const generation = ++this.generation;
		this.at = { source, line, text };
		this.blamed = undefined;
		this.chain = undefined;
		this.state = 'blame';
		this.error = '';
		this.refresh();
		try {
			const [b] = (await blame(this.root, source, { line, cancel: cancel.token })).filter(
				Boolean,
			);
			if (generation !== this.generation) {
				return;
			}
			this.blamed = b;
			if (!b || UNCOMMITTED.test(b.hash)) {
				this.chain = [];
			} else {
				this.state = 'chain';
				this.refresh();
				// Follow the line from the commit that last changed it, in that commit's
				// numbering, so that unsaved or uncommitted edits above it do not shift the
				// range.
				this.chain = await log(
					this.root,
					['-s', `-L${b.origLine},${b.origLine}:${b.filename}`, b.hash],
					{ cancel: cancel.token },
				);
			}
			if (generation !== this.generation) {
				return;
			}
			this.state = 'done';
		} catch (e) {
			if (generation !== this.generation) {
				return;
			}
			this.state = 'error';
			this.error = (e as Error).message;
		}
		this.refresh();
	}

	refresh(): void {
		if (this.view) {
			const at = this.at;
			const rev = at?.source.rev ? `${at.source.rev.slice(0, 12)}:` : '';
			this.view.message = at
				? `${rev}${at.source.file}:${at.line}`
				: 'Put the cursor on a line of a file in the kernel tree.';
		}
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(item: BlameItem): vscode.TreeItem {
		return item;
	}

	getChildren(item?: BlameItem): BlameItem[] {
		if (item) {
			return item.children ?? [];
		}
		if (!this.at) {
			return [];
		}
		const items: BlameItem[] = [];
		const text = new BlameItem(this.at.text || '(empty line)');
		text.iconPath = new vscode.ThemeIcon('symbol-text');
		text.tooltip = this.at.text;
		items.push(text);
		const b = this.blamed;
		if (this.state === 'blame') {
			items.push(spinner('Running git blame…'));
		}
		if (b && UNCOMMITTED.test(b.hash)) {
			const item = new BlameItem('Not committed yet');
			item.iconPath = new vscode.ThemeIcon('circle-outline');
			items.push(item);
		} else if (b) {
			const commit: Commit = {
				hash: b.hash,
				short: b.hash.slice(0, 12),
				subject: b.summary,
				author: b.author,
				email: b.email,
				date: new Date(b.time * 1000).toISOString(),
				path: b.filename,
			};
			items.push(commitItem(commit, b, 'Last changed in'));
			if (this.state === 'chain') {
				items.push(spinner('Following the line back (git log -L)…'));
			} else if (this.chain && this.chain.length) {
				const older = this.chain.slice(1).map(c => commitItem(c, undefined, ''));
				const head = new BlameItem(
					older.length
						? `Earlier changes to this line (${older.length})`
						: 'No earlier changes: this commit added the line',
					older.length ? { children: older } : {},
				);
				head.iconPath = new vscode.ThemeIcon(older.length ? 'history' : 'star-full');
				head.tooltip = older.length
					? 'Oldest last: the bottom one introduced the line'
					: undefined;
				items.push(head);
			}
		}
		if (this.state === 'error') {
			const item = new BlameItem(this.error.split('\n')[0]);
			item.iconPath = new vscode.ThemeIcon('error');
			item.tooltip = this.error;
			items.push(item);
		}
		return items;
	}
}

/** The first line of `file` that `commit` changed, in the parent's numbering. */
async function firstChangedLine(root: string, commit: string, file: string): Promise<number> {
	const diff = await git(root, ['show', '-U0', '--format=', '--no-color', commit, '--', file]);
	const m = /^@@ -(\d+)/m.exec(diff);
	return m ? Math.max(1, +m[1]) : 1;
}

/**
 * Maps a line of `file` in `commit` to the corresponding line of `oldFile` in `parent`,
 * through the commit's diff.
 */
export async function mapToParent(
	root: string,
	parent: string,
	oldFile: string,
	commit: string,
	file: string,
	line: number,
): Promise<number> {
	const diff = await git(root, [
		'diff',
		'-U0',
		'--no-color',
		'-M',
		parent,
		commit,
		'--',
		oldFile,
		file,
	]);
	return mapLine(diff, line, 'toOld');
}

/** A blamed line's number in the commit's parent, through the commit's diff. */
async function lineInParent(root: string, b: BlameLine): Promise<number> {
	const p = b.previous as { hash: string; file: string };
	return mapToParent(root, p.hash, p.file, b.hash, b.filename, b.origLine);
}

function spinner(label: string): BlameItem {
	const item = new BlameItem(label);
	item.iconPath = new vscode.ThemeIcon('loading~spin');
	return item;
}

function commitItem(c: Commit, b: BlameLine | undefined, prefix: string): BlameItem {
	const item = new BlameItem(c.subject, { commit: c, line: b });
	const when = c.date.slice(0, 10);
	item.description = `${prefix ? `${prefix} ` : ''}${c.short} · ${c.author} · ${when}`;
	item.iconPath = new vscode.ThemeIcon('git-commit');
	item.tooltip = new vscode.MarkdownString(
		`**${escapeMd(c.subject)}**\n\n${escapeMd(c.author)} · ${when} · \`${c.hash}\``,
	);
	item.contextValue = 'blameCommit';
	item.command = {
		command: 'kernelWorkbench.git.openCommit',
		title: 'Open Commit',
		arguments: [c.hash, c.path],
	};
	return item;
}

/** The blame annotations, the Blame view and their commands. */
export function registerBlame(
	context: vscode.ExtensionContext,
	root: string,
): { annotations: BlameAnnotations; blameView: BlameView } {
	const annotations = new BlameAnnotations(root);
	const blameView = new BlameView(root);
	const view = vscode.window.createTreeView('kernelWorkbench.blame', {
		treeDataProvider: blameView,
	});
	blameView.view = view;

	/**
	 * Re-blames the file as of `rev` in a tab of its own, at `line`: the kernel way of
	 * looking past a cleanup commit.
	 */
	const blameAt = async (rev: string, file: string, line?: number) => {
		const document = await vscode.workspace.openTextDocument(blobUri(rev, file));
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		if (line) {
			const position = new vscode.Position(Math.min(line, document.lineCount) - 1, 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(
				new vscode.Range(position.line, 0, position.line, 0),
				vscode.TextEditorRevealType.InCenter,
			);
		}
		if (!annotations.isOn(editor)) {
			await annotations.toggle(editor);
		}
		blameView.follow(editor);
	};

	const commands: [string, (...args: any[]) => unknown][] = [
		[
			'kernelWorkbench.blame.toggle',
			async () => {
				const editor = vscode.window.activeTextEditor;
				if (editor) {
					await annotations.toggle(editor);
				}
			},
		],
		[
			'kernelWorkbench.blame.before',
			async (
				arg: string | BlameItem | undefined,
				file: string,
				line: number,
				child: string,
				childFile: string,
			) => {
				if (typeof arg === 'string') {
					// From a hover link: the parent, the file's name there, the child commit,
					// its file, and the line in it.
					const at = await mapToParent(root, arg, file, child, childFile, line);
					return blameAt(arg, file, at);
				}
				// From the Blame view: the commit's parent, the file's name there and the
				// line's number in it come from blame.
				const b = arg?.line;
				if (b?.previous) {
					return blameAt(b.previous.hash, b.previous.file, await lineInParent(root, b));
				}
				if (arg?.commit) {
					// An earlier commit in the chain: open the file before it, at the start of
					// what the commit changed in it.
					const c = arg.commit;
					const name = c.path ?? blameView.at?.source.file;
					if (name) {
						const at = await firstChangedLine(root, c.hash, name);
						return blameAt(`${c.hash}^`, name, at);
					}
				}
				return undefined;
			},
		],
		[
			'kernelWorkbench.blame.copyFixes',
			async (item?: BlameItem) => {
				if (!item?.commit) {
					return;
				}
				const line = await fixesLine(root, item.commit.hash);
				await vscode.env.clipboard.writeText(line);
				vscode.window.showInformationMessage(`Copied: ${line}`);
			},
		],
		[
			'kernelWorkbench.blame.copyHash',
			(item?: BlameItem) => item?.commit && vscode.env.clipboard.writeText(item.commit.hash),
		],
		[
			'kernelWorkbench.blame.openOnLore',
			(item?: BlameItem) => item?.commit && openOnLore(root, item.commit.hash),
		],
	];
	for (const [id, fn] of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	}

	context.subscriptions.push(
		view,
		vscode.languages.registerInlayHintsProvider(
			[{ scheme: 'file' }, { scheme: SCHEME }],
			annotations,
		),
		view.onDidChangeVisibility(() => blameView.follow(vscode.window.activeTextEditor)),
		vscode.window.onDidChangeTextEditorSelection(e => blameView.follow(e.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(editor => {
			vscode.commands.executeCommand(
				'setContext',
				'kernelWorkbench.blameOn',
				!!editor && annotations.isOn(editor),
			);
			blameView.follow(editor);
		}),
		vscode.workspace.onDidChangeTextDocument(e => annotations.changed(e.document)),
		vscode.workspace.onDidSaveTextDocument(document => annotations.changed(document)),
	);
	return { annotations, blameView };
}
