// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): a Build with a bad make argument fails fast and keeps its terminal;
// with KERNEL_E2E=1 a real kernel is built (minutes).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, child, labels, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Build in VS Code', function () {
	this.timeout(30 * 60 * 1000);
	let x: KernelWorkbench;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);
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

	it('fails fast on a bad make argument, and keeps its terminal', async () => {
		await cfg().update(
			'make.args',
			['kwb-no-such-target'],
			vscode.ConfigurationTarget.Workspace,
		);
		try {
			const code = await vscode.commands.executeCommand('kernelWorkbench.build');
			assert.notStrictEqual(code, 0);
			assert.ok(
				terminals().some(t => /Build x86_64 debug/.test(t)),
				terminals().join(', '),
			);
			assert.ok((await status()).includes('Built — not yet'), (await status()).join(', '));
		} finally {
			await cfg().update('make.args', undefined, vscode.ConfigurationTarget.Workspace);
			for (const terminal of vscode.window.terminals) {
				if (/Build/.test(terminal.name)) {
					terminal.dispose();
				}
			}
		}
	});

	const e2e = process.env.KERNEL_E2E === '1' ? it : it.skip;

	e2e('builds the kernel (end to end), and shows the image as Built', async () => {
		const code = await vscode.commands.executeCommand('kernelWorkbench.build');
		assert.strictEqual(code, 0);
		const recorded = x.settings.configured();
		assert.ok(recorded, 'configured');
		const image = x.kbuild.image(recorded);
		assert.ok(fs.existsSync(image), image);
		await until(() => !terminals().some(t => /Build/.test(t)), 5000);
		const built = (await status()).find(l => l.startsWith('Built — '));
		assert.ok(built?.startsWith(`Built — ${path.basename(image)}, `), built);
	});
});
