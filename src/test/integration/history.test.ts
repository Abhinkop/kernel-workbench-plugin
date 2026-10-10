// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): the File History view on a kernel file, paging, filtering and line
// history, and the read-only commit tabs it opens.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { api, file, labels, tree, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('File History in VS Code', function () {
	this.timeout(10 * 60 * 1000);
	let x: KernelWorkbench;
	const git = (...args: string[]) => execFileSync('git', args, { cwd: tree(), encoding: 'utf8' });
	const loaded = () => until(() => !x.history.loading, 120000, 100);

	before(async () => {
		x = await api();
	});

	after(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	it("lists the open file's history, and opens commits in tabs", async () => {
		await vscode.window.showTextDocument(file('kernel/sched/core.c'));
		const h = x.history;
		await vscode.commands.executeCommand(
			'kernelWorkbench.history.showFile',
			file('kernel/sched/core.c'),
		);
		await loaded();
		assert.strictEqual(h.commits.length, 200);
		const rows = await labels(h);
		assert.strictEqual(rows[rows.length - 1], 'Load 200 more…');
		await vscode.commands.executeCommand('kernelWorkbench.history.loadMore');
		await loaded();
		assert.strictEqual(h.commits.length, 400);

		const c = h.commits[0];
		await vscode.commands.executeCommand('kernelWorkbench.git.openCommit', c.hash, c.path);
		await until(
			() => vscode.window.activeTextEditor?.document.uri.scheme === 'kernel-git',
			60000,
			100,
		);
		const editor = vscode.window.activeTextEditor;
		assert.ok(editor);
		assert.strictEqual(editor.document.languageId, 'diff');
		assert.match(editor.document.getText(), new RegExp(`^commit ${c.hash}`));
		const tabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).length;
		const before = tabs();
		await vscode.commands.executeCommand('kernelWorkbench.git.commitFileOnly');
		await until(
			() => !!vscode.window.activeTextEditor?.document.uri.path.startsWith('/file/'),
			60000,
			100,
		);
		assert.strictEqual(tabs(), before, 'the toggle replaces the tab');
		// Typing, as a user would: a commit tab is read-only.
		const now = vscode.window.activeTextEditor;
		assert.ok(now);
		const text = now.document.getText();
		await vscode.commands.executeCommand('type', { text: 'typed into a commit tab' });
		assert.strictEqual(now.document.getText(), text, 'commit tabs are read-only');
		assert.strictEqual(now.document.isDirty, false);
	});

	it('filters by message or author, and shows line history', async () => {
		const h = x.history;
		h.show({ kind: 'file', file: 'kernel/sched/core.c' });
		await loaded();
		h.setFilter('Zijlstra');
		await loaded();
		assert.ok(h.commits.length > 0);
		assert.ok(
			h.commits.some(c => /zijlstra/i.test(c.author)),
			'matches by author',
		);
		h.show({ kind: 'lines', file: 'kernel/sched/core.c', start: 4500, end: 4510 });
		await loaded();
		assert.ok(h.commits.length > 0);
		assert.ok(h.view?.message?.startsWith('Lines 4500–4510'));
	});

	it('opens a commit too large for an editor as one file of it', async function () {
		const huge = git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n').pop() ?? '';
		const changed = git('show', '--numstat', '--format=', huge).split('\n').length;
		if (changed < 1000) {
			this.skip(); // a tree without the 2.6.12 import
		}
		await vscode.commands.executeCommand(
			'kernelWorkbench.git.openCommit',
			huge,
			'kernel/sched.c',
		);
		await until(
			() => !!vscode.window.activeTextEditor?.document.uri.path.includes(huge),
			120000,
			100,
		);
		assert.ok(vscode.window.activeTextEditor?.document.uri.path.startsWith('/file/'));
	});
});
