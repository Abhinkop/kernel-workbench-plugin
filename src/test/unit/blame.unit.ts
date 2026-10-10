// Blame: porcelain parsing, blaming files, unsaved text and revisions, the clickable
// annotations, and the Blame view's chain back to the commit that introduced a line.
import * as assert from 'node:assert/strict';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { extensionContext, fileUri, state, vscode } from '../helpers/vscode';
import { makeRepo } from '../helpers/repo';
import * as blame from '../../blame';
import * as commits from '../../commits';

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

describe('blame', () => {
	const porcelain = [
		'aaaa000000000000000000000000000000000001 3 1 2',
		'author Alice',
		'author-mail <alice@example.com>',
		'author-time 1700000000',
		'summary first change',
		'previous bbbb000000000000000000000000000000000002 old/name.c',
		'filename new/name.c',
		'\tint a;',
		'aaaa000000000000000000000000000000000001 4 2',
		'\tint b;',
		'0000000000000000000000000000000000000000 3 3 1',
		'author Not Committed Yet',
		'summary Version of new/name.c from new/name.c',
		'filename new/name.c',
		'\tint c;',
	].join('\n');

	it('parses porcelain output', () => {
		const l = blame.parsePorcelain(porcelain);
		assert.equal(l.length, 3);
		assert.deepEqual(
			[l[0].origLine, l[0].finalLine, l[0].author, l[0].email, l[0].summary, l[0].text],
			[3, 1, 'Alice', 'alice@example.com', 'first change', 'int a;'],
		);
		assert.deepEqual(l[0].previous, {
			hash: 'bbbb000000000000000000000000000000000002',
			file: 'old/name.c',
		});
		assert.equal(l[1].summary, 'first change', 'repeated commits reuse the header');
		assert.equal(l[1].origLine, 4);
	});

	it('blames files, unsaved text and revisions', async () => {
		const { r, c2, c4 } = historyRepo();
		try {
			let l = await blame.blame(r.dir, { file: 'drivers/foo/bar.c' });
			assert.equal(l.length, 21);
			assert.equal(l[4].hash, c2, 'line 5 last changed by the rework');
			assert.equal(l[20].hash, c4);
			const unsaved = 'inserted\n' + r.read('drivers/foo/bar.c');
			l = await blame.blame(r.dir, { file: 'drivers/foo/bar.c', contents: unsaved });
			assert.match(l[0].hash, /^0{40}$/);
			assert.equal(l[5].hash, c2);
			l = await blame.blame(r.dir, { file: 'drivers/foo/foo.c', rev: c2 }, { line: 5 });
			assert.equal(l.filter(Boolean)[0].hash, c2);
		} finally {
			r.remove();
		}
	});

	it('maps a line of a commit to its parent', async () => {
		const { r, c1, c2 } = historyRepo();
		try {
			const f = 'drivers/foo/foo.c';
			assert.equal(await blame.mapToParent(r.dir, c1, f, c2, f, 10), 10);
			assert.equal(await blame.mapToParent(r.dir, c1, f, c2, f, 5), 5);
		} finally {
			r.remove();
		}
	});

	it('annotates with clickable hashes, grouped by commit', async () => {
		const { r, c2 } = historyRepo();
		try {
			const annotations = new blame.BlameAnnotations(r.dir);
			const shown = await vscode.window.showTextDocument(
				fileUri(path.join(r.dir, 'drivers/foo/bar.c')),
			);
			const editor = shown as unknown as vscodeTypes.TextEditor;
			let changed = 0;
			annotations.onDidChangeInlayHints(() => changed++);
			await annotations.toggle(editor);
			assert.ok(annotations.isOn(editor) && changed === 1);
			const whole = new vscode.Range(0, 0, 25, 0) as unknown as vscodeTypes.Range;
			const hints = annotations.provideInlayHints(editor.document, whole);
			assert.equal(hints.length, 21);
			const labelled = hints.filter(h => (h.label as unknown[]).length === 2);
			assert.ok(labelled.length >= 3, 'one labelled hint per run of lines');
			const rework = hints[4].label as vscodeTypes.InlayHintLabelPart[];
			assert.equal(rework[0].value, c2.slice(0, 8));
			assert.deepEqual(rework[0].command?.arguments, [c2, 'drivers/foo/foo.c']);
			assert.match(
				String((rework[0].tooltip as vscodeTypes.MarkdownString).value),
				/\[Open commit\]\(command:kernelWorkbench\.git\.openCommit/,
			);
			const continuation = hints[1].label as vscodeTypes.InlayHintLabelPart[];
			assert.equal(continuation[0].value.trim(), '', 'continuation lines are padding');
			await annotations.toggle(editor);
			assert.deepEqual(annotations.provideInlayHints(editor.document, whole), []);
			const blameOn = state.executed.filter(
				e => e.id === 'setContext' && e.args[0] === 'kernelWorkbench.blameOn',
			);
			assert.equal(blameOn.pop()?.args[1], false);
		} finally {
			r.remove();
		}
	});

	it('finds the commit that introduced a line, and blames before a commit', async () => {
		const { r, c1, c2 } = historyRepo();
		try {
			const context = extensionContext();
			context.subscriptions.push(
				vscode.workspace.registerTextDocumentContentProvider(
					commits.SCHEME,
					new commits.GitDocuments(r.dir),
				),
			);
			const { blameView } = blame.registerBlame(context, r.dir);
			blameView.view = { visible: true, message: '' };
			await blameView.update({ file: 'drivers/foo/bar.c' }, 5, 'line five');
			const items = blameView.getChildren();
			assert.equal(items[1].commit?.hash, c2);
			assert.equal(blameView.view.message, 'drivers/foo/bar.c:5');
			const earlier = items.find(i => i.children);
			assert.ok(earlier);
			assert.deepEqual(
				earlier.children?.map(i => i.commit?.hash),
				[c1],
				'c1 introduced the line',
			);
			await vscode.commands.executeCommand('kernelWorkbench.blame.before', items[1]);
			assert.match(
				String(state.shown.pop()?.uri),
				new RegExp(`/blob/${c1}/drivers/foo/foo\\.c$`),
			);
			await vscode.commands.executeCommand('kernelWorkbench.blame.copyFixes', items[1]);
			assert.match(state.clipboard, /rework line 5/);
		} finally {
			r.remove();
		}
	});
});
