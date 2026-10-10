// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): Clean on the configured build, menuconfig in an editor-area terminal,
// and Full clean forgetting the configuration.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { api, child, labels, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Clean, Full clean and menuconfig in VS Code', function () {
	this.timeout(5 * 60 * 1000);
	let x: KernelWorkbench;
	const status = async () => labels(x.kernelView, await child(x.kernelView, 'Status'));
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
	});

	it('cleans the configured build, and closes its terminal', async () => {
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.clean'), 0);
		await until(() => !terminals().some(t => /Clean/.test(t)), 5000);
	});

	it('opens menuconfig in a terminal in the editor area', async () => {
		await vscode.commands.executeCommand('kernelWorkbench.menuconfig');
		await until(() => terminals().some(t => /^menuconfig x86_64 debug/.test(t)), 5000);
		const terminal = vscode.window.terminals.find(t => /^menuconfig/.test(t.name));
		assert.ok(terminal);
		const options = terminal.creationOptions as vscode.TerminalOptions;
		assert.strictEqual(options.location, vscode.TerminalLocation.Editor);
		terminal.dispose();
	});

	it('full-cleans, forgetting the configuration', async () => {
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.mrproper'), 0);
		assert.strictEqual(x.settings.configured(), undefined);
		assert.ok((await status()).includes('Configured — not yet'), (await status()).join(', '));
		const steps = await labels(x.kernelView, await child(x.kernelView, 'Steps'));
		assert.ok(steps.includes('Build — x86_64 Debug (not configured yet)'), steps.join(', '));
		// Leave the tree configured for the other test files.
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.configure'), 0);
	});
});
