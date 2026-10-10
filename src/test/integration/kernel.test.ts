// Runs inside VS Code with a real kernel clone open (npm run test:integration): the extension
// activates, its commands and Kernel view are there, and the target changes through the real
// quick pick.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { api, child, file, ID, labels, sleep } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Kernel Workbench in VS Code', () => {
	let x: KernelWorkbench;

	it('activates in a kernel tree', async () => {
		x = await api();
		assert.ok(vscode.extensions.getExtension(ID)?.isActive);
		assert.ok(x.settings && x.kernelView);
	});

	it('registers every contributed command', async () => {
		const all = new Set(await vscode.commands.getCommands(true));
		const manifest = vscode.extensions.getExtension(ID)?.packageJSON;
		const contributed: string[] = manifest.contributes.commands.map((c: any) => c.command);
		assert.ok(contributed.length > 0);
		assert.deepStrictEqual(
			contributed.filter(c => !all.has(c)),
			[],
		);
	});

	it('opens the Kernel view', async () => {
		await vscode.commands.executeCommand('kernelWorkbench.kernel.focus');
	});

	describe('Kernel view', () => {
		it('shows the target', async () => {
			const rows = await labels(x.kernelView, undefined, 2);
			assert.deepStrictEqual(
				rows.filter(l => !l.startsWith(' ')),
				['Steps', 'Target', 'Status'],
			);
			assert.ok(
				rows.some(l => /^ {2}Architecture — \w+/.test(l)),
				rows.join('\n'),
			);
			assert.ok(
				rows.some(l => /^ {2}Build — (Debug|Release)$/.test(l)),
				rows.join('\n'),
			);
			assert.ok(
				rows.some(l => /^ {2}Base config — \S+/.test(l)),
				rows.join('\n'),
			);
		});

		/**
		 * Accepts the second entry of the quick pick that `opening` shows, as a user would
		 * with the keyboard: the pick opens on the first entry.
		 */
		async function pickSecond(opening: Thenable<unknown>) {
			await sleep(400);
			await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			await opening;
		}

		it('changes the architecture through the real quick pick', async () => {
			const before = x.settings.arch;
			try {
				await pickSecond(vscode.commands.executeCommand('kernelWorkbench.selectArch'));
				assert.strictEqual(x.settings.arch, 'arm64');
				const target = await child(x.kernelView, 'Target');
				assert.match((await labels(x.kernelView, target))[0], /^Architecture — arm64/);
			} finally {
				await x.settings.select('arch', before);
			}
		});

		it('opens a row’s picker through Change…', async () => {
			const before = x.settings.variant;
			try {
				const target = await child(x.kernelView, 'Target');
				const build = await child(x.kernelView, 'Build', target);
				assert.ok(build, 'the Build row');
				await pickSecond(vscode.commands.executeCommand('kernelWorkbench.editItem', build));
				assert.strictEqual(x.settings.variant, 'release');
				// The view re-renders new rows; the ones fetched above show the old value.
				const fresh = await child(x.kernelView, 'Target');
				assert.match((await labels(x.kernelView, fresh))[1], /^Build — Release$/);
			} finally {
				await x.settings.select('variant', before);
			}
		});
	});

	describe('editor', () => {
		it('opens kernel source files', async () => {
			const editor = await vscode.window.showTextDocument(file('kernel/sched/core.c'));
			assert.strictEqual(editor.document.languageId, 'c');
		});
	});
});
