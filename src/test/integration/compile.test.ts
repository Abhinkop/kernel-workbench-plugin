// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): one file compiled and preprocessed, a directory built, and (end to end)
// the modules.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, file, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Compiling one file or directory in VS Code', function () {
	this.timeout(10 * 60 * 1000);
	let x: KernelWorkbench;
	const terminals = () => vscode.window.terminals.map(t => t.name);

	before(async () => {
		x = await api();
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		await x.settings.select('config', 'defconfig');
		if (!x.settings.configured()) {
			assert.strictEqual(
				await vscode.commands.executeCommand('kernelWorkbench.configure'),
				0,
			);
		}
		await vscode.window.showTextDocument(file('init/main.c'));
	});

	after(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	it('compiles the file in the editor', async () => {
		const code = await vscode.commands.executeCommand('kernelWorkbench.compileFile');
		assert.strictEqual(code, 0);
		const recorded = x.settings.configured();
		assert.ok(recorded);
		assert.ok(fs.existsSync(path.join(recorded.buildDir, 'init/main.o')));
		await until(() => !terminals().some(t => /Compile/.test(t)), 5000);
	});

	it('preprocesses it, and opens the result beside the editor', async () => {
		const code = await vscode.commands.executeCommand('kernelWorkbench.preprocessFile');
		assert.strictEqual(code, 0);
		await until(
			() => /init\/main\.i$/.test(vscode.window.activeTextEditor?.document.fileName ?? ''),
			10000,
		);
	});

	it('refuses a file that is not C', async () => {
		await vscode.window.showTextDocument(file('Kbuild'));
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.compileFile'), 1);
		await vscode.window.showTextDocument(file('init/main.c'));
	});

	it('builds a directory', async () => {
		const code = await vscode.commands.executeCommand(
			'kernelWorkbench.buildDirectory',
			file('init'),
		);
		assert.strictEqual(code, 0);
		await until(() => !terminals().some(t => /Build init/.test(t)), 5000);
	});

	const e2e = process.env.KERNEL_E2E === '1' ? it : it.skip;

	e2e('builds the modules (end to end), once the kernel is built', async () => {
		// modpost needs vmlinux.o: Build Modules only works after a Build.
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.build'), 0);
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.buildModules'), 0);
	});
});
