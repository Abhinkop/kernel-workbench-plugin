// The git helpers, the read-only commit documents, and the File History view with its
// commands, on throwaway repositories.
import * as assert from 'node:assert/strict';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { answer, extensionContext, fileUri, state, vscode } from '../helpers/vscode';
import { makeRepo } from '../helpers/repo';
import * as git from '../../git';
import * as commits from '../../commits';
import { FileHistory, openOnLore, registerHistory } from '../../history';

const lines = (n: number, prefix = 'line') =>
	Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

/** A repository with a file edited over a few commits and then renamed. */
function historyRepo() {
	const r = makeRepo();
	const edited = lines(20).replace('line 5\n', 'line five\n');
	const c1 = r.commit(
		'drivers/foo: add foo.c',
		{ 'drivers/foo/foo.c': lines(20) },
		'2026-01-01T10:00:00Z',
	);
	const c2 = r.commit(
		'drivers/foo: rework line 5',
		{ 'drivers/foo/foo.c': edited },
		'2026-01-02T10:00:00Z',
	);
	const c3 = r.commit(
		'drivers/foo: rename foo.c to bar.c',
		{ 'drivers/foo/foo.c': null, 'drivers/foo/bar.c': edited },
		'2026-01-03T10:00:00Z',
	);
	const c4 = r.commit(
		'drivers/foo: append a line',
		{ 'drivers/foo/bar.c': edited + 'line 21\n' },
		'2026-01-04T10:00:00Z',
	);
	return { r, c1, c2, c3, c4 };
}

const wait = async (condition: () => boolean, ms = 5000) => {
	for (let t = 0; t < ms && !condition(); t += 20) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
};

describe('git helpers', () => {
	it('parses git log, with file names for --follow', async () => {
		const { r, c1, c4 } = historyRepo();
		try {
			const log = await git.log(r.dir, ['--follow'], {
				paths: ['drivers/foo/bar.c'],
				names: true,
			});
			assert.deepEqual(
				log.map(c => c.subject),
				[
					'drivers/foo: append a line',
					'drivers/foo: rename foo.c to bar.c',
					'drivers/foo: rework line 5',
					'drivers/foo: add foo.c',
				],
			);
			assert.equal(log[0].hash, c4);
			assert.equal(log[3].hash, c1);
			assert.equal(log[3].path, 'drivers/foo/foo.c', 'the name before the rename');
			assert.equal(log[0].author, 'Test Author');
			assert.ok(log[0].short.length >= 7);
		} finally {
			r.remove();
		}
	});

	it('formats Fixes: lines and checks revisions', async () => {
		const { r, c2 } = historyRepo();
		try {
			assert.equal(
				await git.fixesLine(r.dir, c2),
				`Fixes: ${c2.slice(0, 12)} ("drivers/foo: rework line 5")`,
			);
			assert.equal(await git.exists(r.dir, c2), true);
			assert.equal(await git.exists(r.dir, 'nope'), false);
			await assert.rejects(git.git(r.dir, ['show', 'nope']), /nope/);
			assert.notEqual((await git.gitStatus(r.dir, ['rev-parse', 'nope'])).code, 0);
		} finally {
			r.remove();
		}
	});

	it('makes paths relative to the tree', () => {
		assert.equal(git.relative('/k', '/k/a/b.c'), 'a/b.c');
		assert.equal(git.relative('/k', '/other/b.c'), undefined);
		assert.equal(git.relative('/k', '/k'), undefined);
	});

	it('maps line numbers across diffs', () => {
		// Line 3 changed, 2 lines inserted after old line 6, old line 10 deleted.
		const diff = '@@ -3 +3 @@\n@@ -6,0 +7,2 @@\n@@ -10 +11,0 @@\n';
		const toNew = (l: number) => git.mapLine(diff, l, 'toNew');
		const toOld = (l: number) => git.mapLine(diff, l, 'toOld');
		assert.deepEqual([1, 2, 3, 4, 6, 7, 9, 11, 12].map(toNew), [1, 2, 3, 4, 6, 9, 11, 12, 13]);
		assert.deepEqual([1, 6, 7, 8, 9, 11, 12].map(toOld), [1, 6, 6, 6, 7, 9, 11]);
		assert.equal(git.mapLine('', 5, 'toNew'), 5);
	});

	it('maps a committed line to the working tree', async () => {
		const { r, c4 } = historyRepo();
		try {
			r.write('drivers/foo/bar.c', 'new top\nnew top 2\n' + r.read('drivers/foo/bar.c'));
			assert.equal(await git.lineInWorkingTree(r.dir, c4, 'drivers/foo/bar.c', 10), 12);
		} finally {
			r.remove();
		}
	});
});

describe('commit documents', () => {
	it('shows a commit whole, one file of it, its file list, and a blob', async () => {
		const { r, c2, c3 } = historyRepo();
		try {
			const docs = new commits.GitDocuments(r.dir);
			const content = (uri: vscodeTypes.Uri) => docs.provideTextDocumentContent(uri);
			const full = await content(commits.commitUri(c2, 'x', 'full', 'drivers/foo/foo.c'));
			assert.match(full, new RegExp(`^commit ${c2}`));
			assert.match(full, /^AuthorDate:/m);
			assert.match(full, /-line 5\n\+line five/);
			const renamed = await content(commits.commitUri(c3, 'x', 'file', 'drivers/foo/bar.c'));
			assert.match(
				renamed,
				/rename from drivers\/foo\/foo\.c/,
				'the file view keeps renames',
			);
			const stat = await content(commits.commitUri(c3, 'x', 'stat'));
			assert.match(stat, /foo\.c => bar\.c/);
			assert.ok(!/^diff --git/m.test(stat));
			assert.equal(
				await content(commits.blobUri(c2, 'drivers/foo/foo.c')),
				lines(20).replace('line 5\n', 'line five\n'),
			);
			assert.equal(await content(commits.blobUri(c2, 'no/such.c')), '', 'a missing blob');
			const missing = commits.commitUri('0'.repeat(40), 'x', 'commit');
			assert.match(await content(missing), /^Could not read/);
		} finally {
			r.remove();
		}
	});

	it('names tabs after the commit and opens them', async () => {
		const { r, c2 } = historyRepo();
		try {
			const subject = 'drivers/foo: rework: line 5?';
			const uri = commits.commitUri(c2, subject, 'full', 'drivers/foo/foo.c');
			assert.equal(uri.scheme, 'kernel-git');
			assert.equal(uri.path, `/full/${c2}/${c2.slice(0, 12)} drivers foo rework line 5.diff`);
			assert.equal(decodeURIComponent(uri.query), 'drivers/foo/foo.c');
			assert.equal(commits.hashOf(uri), c2);
			const context = extensionContext();
			context.subscriptions.push(
				vscode.workspace.registerTextDocumentContentProvider(
					commits.SCHEME,
					new commits.GitDocuments(r.dir),
				),
			);
			await commits.openCommit(r.dir, c2, { file: 'drivers/foo/foo.c' });
			assert.match(String(state.shown.pop()?.uri), /^kernel-git:\/full\//);
			assert.match(
				String(vscode.window.activeTextEditor?.document.getText?.()),
				new RegExp(`^commit ${c2}`),
			);
			await commits.toggleCommitView(
				vscode.window.activeTextEditor?.document.uri as unknown as vscodeTypes.Uri,
				true,
			);
			assert.match(String(state.shown.pop()?.uri), /^kernel-git:\/file\//);
		} finally {
			r.remove();
		}
	});
});

describe('file history', () => {
	it("lists a file's commits following renames, filters, and line history", async () => {
		const { r, c2, c4 } = historyRepo();
		try {
			const h = new FileHistory(r.dir);
			h.view = { message: '', description: '' };
			h.show({ kind: 'file', file: 'drivers/foo/bar.c' });
			await wait(() => !h.loading);
			const items = h.getChildren();
			assert.deepEqual(items.map(i => i.label).slice(0, 2), [
				'drivers/foo: append a line',
				'drivers/foo: rename foo.c to bar.c',
			]);
			assert.equal(items.length, 4);
			assert.equal(h.view.description, '4 commits');
			assert.deepEqual(items[0].command?.arguments, [c4, 'drivers/foo/bar.c']);
			assert.equal(items[3].file, 'drivers/foo/foo.c');

			h.setFilter('rework');
			await wait(() => !h.loading);
			assert.deepEqual(
				h.getChildren().map(i => i.label),
				['drivers/foo: rework line 5'],
			);
			h.setFilter('nothing matches this');
			await wait(() => !h.loading);
			assert.deepEqual(
				h.getChildren().map(i => i.label),
				['No matching commits.'],
			);

			h.show({ kind: 'lines', file: 'drivers/foo/bar.c', start: 5, end: 5 });
			await wait(() => !h.loading);
			assert.ok(
				h.commits.some(c => c.hash === c2),
				'the commit that changed line 5',
			);
			assert.equal(h.view.message, 'Lines 5–5 of drivers/foo/bar.c');
		} finally {
			r.remove();
		}
	});

	it('pages long histories 200 at a time', async function () {
		this.timeout(120000);
		const r = makeRepo();
		try {
			for (let i = 1; i <= 205; i++) {
				r.commit(`change ${i}`, { 'f.c': `${i}\n` });
			}
			const h = new FileHistory(r.dir);
			h.show({ kind: 'file', file: 'f.c' });
			await wait(() => !h.loading, 60000);
			assert.equal(h.commits.length, 200);
			assert.equal(h.getChildren().pop()?.label, 'Load 200 more…');
			await h.load();
			assert.equal(h.commits.length, 205);
		} finally {
			r.remove();
		}
	});

	it('follows the editor and runs its commands', async () => {
		const { r, c2, c3 } = historyRepo();
		try {
			const context = extensionContext();
			context.subscriptions.push(
				vscode.workspace.registerTextDocumentContentProvider(
					commits.SCHEME,
					new commits.GitDocuments(r.dir),
				),
			);
			const h = registerHistory(context, r.dir);
			assert.equal(state.providers['tree:kernelWorkbench.history'].provider, h);
			await vscode.window.showTextDocument(fileUri(path.join(r.dir, 'drivers/foo/bar.c')));
			h.followEditor(vscode.window.activeTextEditor as unknown as vscodeTypes.TextEditor);
			await wait(() => !h.loading && h.commits.length > 0);
			const item = h.getChildren().find(i => i.commit?.hash === c3);
			assert.ok(item);
			await vscode.commands.executeCommand('kernelWorkbench.git.copyFixes', item);
			assert.match(
				state.clipboard,
				/^Fixes: [0-9a-f]{12} \("drivers\/foo: rename foo\.c to bar\.c"\)$/,
			);
			await vscode.commands.executeCommand('kernelWorkbench.git.copyHash', item);
			assert.equal(state.clipboard, c3);
			await vscode.commands.executeCommand('kernelWorkbench.git.compareWithPrevious', item);
			const diff = state.executed.find(e => e.id === 'vscode.diff');
			assert.match(
				String(diff?.args[0]),
				new RegExp(`/blob/${c3}\\^/drivers/foo/foo\\.c$`),
				'the old name on the left',
			);
			await vscode.commands.executeCommand('kernelWorkbench.git.openAtCommit', item);
			assert.match(String(state.shown.pop()?.uri), /\/blob\//);
			answer('Search lore');
			await openOnLore(r.dir, c2);
			assert.match(
				String(state.log.pop()?.message),
				new RegExp(
					'^https://lore\\.kernel\\.org/all/\\?q=' +
						's%3A%22drivers%2Ffoo%3A%20rework%20line%205%22$',
				),
			);
		} finally {
			r.remove();
		}
	});
});
