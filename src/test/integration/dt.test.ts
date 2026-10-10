// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): the devicetree checks say why they are skipped on x86_64 and without
// uncommitted changes, and run (or say what is missing) on an arm64 configuration.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { answer, api } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Devicetree checks in VS Code', function () {
	this.timeout(10 * 60 * 1000);
	let x: KernelWorkbench;

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

	after(async () => {
		await x.settings.select('arch', 'x86_64');
	});

	it('says why it skips: no changes, and no devicetree on x86_64', async () => {
		const messages = answer('showInformationMessage', [undefined, undefined]);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.dt.checkChanged');
			await vscode.commands.executeCommand('kernelWorkbench.dt.checkAll');
		} finally {
			messages.restore();
		}
		assert.match(String(messages.asked[0]?.[0]), /no uncommitted changes/);
		assert.match(String(messages.asked[1]?.[0]), /x86_64 kernels do not use devicetree/);
	});

	it('checks all dtbs of an arm64 build, or says what is missing', async () => {
		await x.settings.select('arch', 'arm64');
		if (!x.settings.configured()) {
			assert.strictEqual(
				await vscode.commands.executeCommand('kernelWorkbench.configure'),
				0,
			);
		}
		const messages = answer('showInformationMessage', [undefined]);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.dt.checkAll');
		} finally {
			messages.restore();
		}
		assert.match(
			String(messages.asked[0]?.[0]),
			/^Kernel: (DT check \(all dtbs\): |skipped: dt-schema is not installed)/,
		);
	});
});
