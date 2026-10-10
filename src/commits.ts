import * as vscode from 'vscode';
import { git } from './git';

/**
 * Read-only documents for git objects, opened as ordinary editor tabs so that they can be
 * scrolled, searched and copied like any file:
 *
 *   kernel-git:/commit/<hash>/<title>.diff          the whole commit
 *   kernel-git:/full/<hash>/<title>.diff?<file>     the whole commit, opened from <file>
 *   kernel-git:/file/<hash>/<title>.diff?<file>     only <file>'s part of the commit
 *   kernel-git:/stat/<hash>/<title>.diff            the message and file list only (huge commits)
 *   kernel-git:/blob/<rev>/<path>                   <path> as of <rev>
 *
 * The .diff suffix gives commits diff highlighting; blobs keep their own file name, so they
 * get the language of the file.
 */
export const SCHEME = 'kernel-git';

type Kind = 'commit' | 'full' | 'file' | 'stat';

/** The tree the kernel-git documents come from (one tree per extension host). */
let providerRoot = '';

export class GitDocuments implements vscode.TextDocumentContentProvider {
	constructor(private readonly root: string) {
		providerRoot = root;
	}

	/**
	 * The file's names in a commit: limiting `git show` to the new name alone defeats rename
	 * detection and shows a rename as a new file, so the old name is included when the commit
	 * renamed it.
	 */
	async namesIn(rev: string, file: string): Promise<string[]> {
		const status = await git(this.root, ['show', '-M', '--format=', '--name-status', rev]);
		for (const line of status.split('\n')) {
			const [st, from, to] = line.split('\t');
			if (st && st.startsWith('R') && to === file) {
				return [from, to];
			}
		}
		return [file];
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const [, kind, rev, ...rest] = uri.path.split('/');
		const file = decodeURIComponent(uri.query);
		try {
			if (kind === 'blob') {
				return await git(this.root, ['show', `${rev}:${rest.join('/')}`]);
			}
			if (kind === 'stat') {
				return await git(this.root, [
					'show',
					'--format=fuller',
					'--stat=200',
					'--no-color',
					rev,
				]);
			}
			const args = ['show', '--format=fuller', '--stat', '--patch', '-M', '--no-color', rev];
			if (kind === 'file' && file) {
				args.push('--', ...(await this.namesIn(rev, file)));
			}
			return await git(this.root, args);
		} catch (e) {
			// A blob that does not exist at that revision (added or deleted there) reads as
			// empty, which is what a diff against it needs.
			return kind === 'blob' ? '' : `Could not read ${rev}:\n${(e as Error).message}\n`;
		}
	}
}

/** The document of a commit, named after it. */
export function commitUri(hash: string, subject: string, kind: Kind, file?: string): vscode.Uri {
	const title = `${hash.slice(0, 12)} ${subject}`
		.replace(/[\\/:*?"<>|#%]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
	return vscode.Uri.from({
		scheme: SCHEME,
		path: `/${kind}/${hash}/${title}.diff`,
		query: file ? encodeURIComponent(file) : '',
	});
}

/** The document of `file` (relative to the tree) as of `rev`. */
export function blobUri(rev: string, file: string): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: `/blob/${rev}/${file}` });
}

/** Changed lines above which a whole commit is not opened. */
const HUGE = 200000;

/** The lines a commit adds plus removes. */
async function changedLines(root: string, hash: string): Promise<number> {
	const out = await git(root, ['show', '--numstat', '--format=', hash]);
	let n = 0;
	for (const line of out.split('\n')) {
		const [added, deleted] = line.split('\t');
		n += (+added || 0) + (+deleted || 0);
	}
	return n;
}

/** Opens a commit in an editor tab: whole, or `file`'s part of it when `onlyFile`. */
export async function openCommit(
	root: string,
	rev: string,
	options: { file?: string; onlyFile?: boolean } = {},
): Promise<void> {
	const [hash, subject] = (await git(root, ['log', '-1', '--format=%H%x00%s', rev]))
		.trim()
		.split('\0');
	let kind: Kind = options.file ? (options.onlyFile ? 'file' : 'full') : 'commit';
	// VS Code does not open a document over 50 MB, which some commits are as a whole (the
	// 2.6.12 import that much old code blames to): show only the file's part of those, or
	// just the message and file list.
	if (kind !== 'file') {
		const lines = await changedLines(root, hash);
		if (lines > HUGE) {
			kind = options.file ? 'file' : 'stat';
			const shown = options.file ? `only ${options.file}` : 'its message and file list';
			vscode.window.showInformationMessage(
				`Kernel: ${hash.slice(0, 12)} changes ${lines.toLocaleString()} lines; ` +
					`showing ${shown}.`,
			);
		}
	}
	const document = await vscode.workspace.openTextDocument(
		commitUri(hash, subject, kind, options.file),
	);
	await vscode.window.showTextDocument(document, { preview: false });
}

/** Switches an open commit tab between the whole commit and the file's part. */
export async function toggleCommitView(
	uri: vscode.Uri | undefined,
	onlyFile: boolean,
): Promise<void> {
	if (!uri || uri.scheme !== SCHEME) {
		return;
	}
	const [, , hash, ...rest] = uri.path.split('/');
	let kind: Kind = onlyFile ? 'file' : 'full';
	if (!onlyFile && (await changedLines(providerRoot, hash)) > HUGE) {
		kind = 'stat';
		vscode.window.showInformationMessage(
			`Kernel: ${hash.slice(0, 12)} is too large to show whole; ` +
				'showing its message and file list.',
		);
	}
	const target = uri.with({ path: `/${kind}/${hash}/${rest.join('/')}` });
	// Replace the tab rather than piling up a second one.
	if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) {
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	}
	const document = await vscode.workspace.openTextDocument(target);
	await vscode.window.showTextDocument(document, { preview: false });
}

/** The commit's hash from a kernel-git commit document's Uri. */
export function hashOf(uri: vscode.Uri): string | undefined {
	return uri.scheme === SCHEME ? uri.path.split('/')[2] : undefined;
}
