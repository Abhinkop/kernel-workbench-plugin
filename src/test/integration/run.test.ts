// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): Run refused without a kernel image; with KERNEL_E2E=1, the built
// kernel booted in QEMU to a busybox initramfs, shown as running, and stopped.
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { answer, api, busyboxInitramfs, child, labels, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Run in QEMU in VS Code', function () {
	this.timeout(30 * 60 * 1000);
	let x: KernelWorkbench;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);
	const set = (key: string, value: unknown) =>
		cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
	const status = async () => labels(x.kernelView, await child(x.kernelView, 'Status'));
	const steps = async () => labels(x.kernelView, await child(x.kernelView, 'Steps'));

	before(async () => {
		x = await api();
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		await x.settings.select('config', 'defconfig');
	});

	after(async () => {
		for (const key of ['buildBeforeRun', 'run.initramfs', 'run.kvm']) {
			await set(key, undefined);
		}
	});

	it('refuses to run without a kernel image', async () => {
		await set('buildBeforeRun', false);
		await x.settings.select('variant', 'release'); // never configured, so never built
		const errors = answer('showErrorMessage', [undefined]);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.run');
		} finally {
			errors.restore();
			await x.settings.select('variant', 'debug');
		}
		assert.match(String(errors.asked[0]?.[0]), /no x86_64 release kernel image/);
		assert.ok(!x.runner.running);
	});

	const e2e = process.env.KERNEL_E2E === '1' ? it : it.skip;

	e2e('boots the built kernel to an initramfs shell, and stops it', async () => {
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.build'), 0);
		await set('buildBeforeRun', false);
		await set('run.initramfs', { x86_64: busyboxInitramfs() });
		await set('run.kvm', fs.existsSync('/dev/kvm') ? 'auto' : 'off');
		const recorded = x.settings.configured();
		assert.ok(recorded);
		const log = x.runner.consoleLog(recorded);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.run');
			assert.ok(x.runner.running, 'the VM terminal is open');
			await until(async () => (await steps()).includes('Stop VM — the VM is running'), 5000);
			assert.ok((await status()).includes('VM — running'));
			await until(
				() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('KWB-INIT-RAN'),
				180000,
				200,
			);
		} finally {
			await vscode.commands.executeCommand('kernelWorkbench.stop');
		}
		await until(() => !x.runner.running, 10000);
		await until(async () => (await status()).includes('VM — stopped'), 5000);
		assert.ok((await steps()).some(s => s.startsWith('Run — ')));
	});
});
