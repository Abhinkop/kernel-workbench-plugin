// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): blame annotations on a kernel file with clickable hashes, and the Blame
// view following the cursor back to the commit that introduced the line.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { api, file, labels, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Blame in VS Code', function () {
	this.timeout(10 * 60 * 1000);
	let x: KernelWorkbench;
	const range = new vscode.Range(0, 0, 200, 0);
	const hints = async (uri: vscode.Uri) =>
		(
			await vscode.commands.executeCommand<vscode.InlayHint[]>(
				'vscode.executeInlayHintProvider',
				uri,
				range,
			)
		).filter(h => Array.isArray(h.label));

	before(async () => {
		x = await api();
	});

	after(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	it('annotates blame with clickable hashes, and opens the commit', async () => {
		const editor = await vscode.window.showTextDocument(file('kernel/sched/core.c'));
		await vscode.commands.executeCommand('kernelWorkbench.blame.toggle');
		let found: vscode.InlayHint[] = [];
		await until(async () => (found = await hints(editor.document.uri)).length > 0, 120000, 250);
		const link = found.find(h => {
			const part = (h.label as vscode.InlayHintLabelPart[])[0];
			return !!part.command && !part.value.startsWith('1da177e4');
		});
		assert.ok(link, 'a hint with a clickable hash');
		const part = (link.label as vscode.InlayHintLabelPart[])[0];
		assert.strictEqual(part.command?.command, 'kernelWorkbench.git.openCommit');
		await vscode.commands.executeCommand(
			part.command.command,
			...(part.command.arguments ?? []),
		);
		await until(
			() => vscode.window.activeTextEditor?.document.uri.scheme === 'kernel-git',
			60000,
			100,
		);
		assert.match(
			vscode.window.activeTextEditor?.document.getText() ?? '',
			new RegExp(`^commit ${part.command.arguments?.[0]}`),
		);
		await vscode.window.showTextDocument(editor.document);
		await vscode.commands.executeCommand('kernelWorkbench.blame.toggle');
		assert.strictEqual((await hints(editor.document.uri)).length, 0);
	});

	it('follows the cursor in the Blame view back to the introducing commit', async () => {
		const editor = await vscode.window.showTextDocument(file('kernel/sched/core.c'));
		await vscode.commands.executeCommand('kernelWorkbench.blame.focus');
		const view = x.blame.blameView;
		editor.selection = new vscode.Selection(4504, 0, 4504, 0);
		// The view follows the focus first (line 1), then the cursor, a moment after it settles.
		await until(
			() => view.at?.line === 4505 && (view.state === 'done' || view.state === 'error'),
			120000,
			100,
		);
		assert.strictEqual(view.state, 'done', view.error);
		assert.strictEqual(view.view?.message, 'kernel/sched/core.c:4505');
		const rows = await labels(view);
		assert.ok(rows.length >= 2, rows.join('\n'));
		assert.ok(view.getChildren()[1].commit, 'the commit that last changed the line');
	});
});
