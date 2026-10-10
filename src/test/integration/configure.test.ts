// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): Configure really configures the tree, the Kernel tab shows it, and
// a failed Configure leaves its terminal to read.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, child, labels, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Configure in VS Code', function () {
	this.timeout(5 * 60 * 1000);
	let x: KernelWorkbench;

	before(async () => {
		x = await api();
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		await x.settings.select('config', 'defconfig');
	});

	const status = async () => labels(x.kernelView, await child(x.kernelView, 'Status'));
	const terminals = () => vscode.window.terminals.map(t => t.name);

	it('shows the Configure step and that nothing is configured yet', async () => {
		const steps = await labels(x.kernelView, await child(x.kernelView, 'Steps'));
		assert.deepStrictEqual(steps, ['Configure — x86_64 Debug from defconfig']);
		assert.deepStrictEqual(await status(), ['Configured — not yet']);
	});

	it('configures with the Debug options, and closes its terminal', async () => {
		const code = await vscode.commands.executeCommand('kernelWorkbench.configure');
		assert.strictEqual(code, 0);
		const recorded = x.settings.configured();
		assert.ok(recorded, 'the configure state was recorded');
		assert.strictEqual(recorded.config, 'defconfig');
		assert.ok(recorded.makeArgs.includes('ARCH=x86_64'), recorded.makeArgs.join(' '));
		const config = fs.readFileSync(path.join(recorded.buildDir, '.config'), 'utf8');
		assert.match(config, /^CONFIG_GDB_SCRIPTS=y$/m);
		assert.match(config, /^CONFIG_DEBUG_INFO_DWARF_TOOLCHAIN_DEFAULT=y$/m);
		const [configured] = await status();
		assert.match(configured, /^Configured — (?!not yet)/);
		// A disposed terminal leaves vscode.window.terminals a moment later.
		await until(() => !terminals().some(t => /Configure/.test(t)), 5000);
	});

	it('keeps the terminal of a Configure that failed', async () => {
		await x.settings.select('config', 'kwb-no-such-target');
		try {
			const code = await vscode.commands.executeCommand('kernelWorkbench.configure');
			assert.notStrictEqual(code, 0);
			assert.ok(
				terminals().some(t => /Configure x86_64 debug/.test(t)),
				terminals().join(', '),
			);
		} finally {
			await x.settings.select('config', 'defconfig');
			for (const terminal of vscode.window.terminals) {
				if (/Configure/.test(terminal.name)) {
					terminal.dispose();
				}
			}
		}
	});
});
