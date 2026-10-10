// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): options edited from their rows in the Kernel tab, and, with
// KERNEL_E2E=1, the build directory shared with the guest over 9p and a module built in the
// tree loaded there.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { answer, api, busyboxInitramfs, child, labels, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Options in VS Code', function () {
	this.timeout(30 * 60 * 1000);
	let x: KernelWorkbench;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);
	const set = (key: string, value: unknown) =>
		cfg().update(key, value, vscode.ConfigurationTarget.Workspace);

	before(async () => {
		x = await api();
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		await x.settings.select('config', 'defconfig');
	});

	it('edits options from their rows', async () => {
		const options = await child(x.kernelView, 'Options');
		const ccache = await child(x.kernelView, 'ccache', options);
		assert.ok(ccache, 'the ccache row');
		const before = cfg().get('make.ccache');
		await vscode.commands.executeCommand('kernelWorkbench.editItem', ccache);
		await until(() => cfg().get('make.ccache') === !before);
		const input = answer('showInputBox', ['W=1 KCFLAGS="-Og -g"']);
		try {
			const makeArgs = await child(x.kernelView, 'Extra make arguments', options);
			await vscode.commands.executeCommand('kernelWorkbench.editItem', makeArgs);
		} finally {
			input.restore();
		}
		assert.deepStrictEqual(cfg().get('make.args'), ['W=1', 'KCFLAGS=-Og -g']);
		const fresh = await child(x.kernelView, 'Options');
		const row = (await labels(x.kernelView, fresh)).find(l => l.startsWith('Extra make'));
		assert.match(String(row), /W=1 "KCFLAGS=-Og -g"/);
		await cfg().update('make.ccache', undefined, vscode.ConfigurationTarget.Global);
		await cfg().update('make.args', undefined, vscode.ConfigurationTarget.Global);
	});

	const e2e = process.env.KERNEL_E2E === '1' ? it : it.skip;

	e2e('shares the build directory over 9p, and loads a module built in the tree', async () => {
		await set('run.shareBuildDir', true);
		await set('configure.options', { DUMMY: 'm' });
		await set('run.initramfs', { x86_64: busyboxInitramfs() });
		await set('run.kvm', fs.existsSync('/dev/kvm') ? 'auto' : 'off');
		await set('buildBeforeRun', false);
		try {
			assert.strictEqual(
				await vscode.commands.executeCommand('kernelWorkbench.configure'),
				0,
			);
			assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.build'), 0);
			const recorded = x.settings.configured();
			assert.ok(recorded);
			const conf = fs.readFileSync(path.join(recorded.buildDir, '.config'), 'utf8');
			assert.match(conf, /^CONFIG_9P_FS=y$/m);
			assert.match(conf, /^CONFIG_NET_9P_VIRTIO=y$/m);
			assert.match(conf, /^CONFIG_DUMMY=m$/m);
			assert.ok(fs.existsSync(path.join(recorded.buildDir, 'drivers/net/dummy.ko')));

			const log = x.runner.consoleLog(recorded);
			const has = (re: RegExp) => fs.existsSync(log) && re.test(fs.readFileSync(log, 'utf8'));
			await vscode.commands.executeCommand('kernelWorkbench.run');
			await until(() => has(/KWB-INIT-RAN/), 180000, 200);
			x.runner.vm?.sendText(
				'mkdir -p /mnt/kbuild && ' +
					'mount -t 9p -o trans=virtio,version=9p2000.L kbuild /mnt/kbuild && ' +
					'insmod /mnt/kbuild/drivers/net/dummy.ko && ' +
					'echo KWB-INSMOD-$(grep -c "^dummy " /proc/modules)',
			);
			await until(() => has(/KWB-INSMOD-1/), 60000, 200);
			assert.ok(!has(/KWB-INSMOD-0|Invalid module format|insmod: can't/));
		} finally {
			await vscode.commands.executeCommand('kernelWorkbench.stop');
			for (const key of [
				'run.shareBuildDir',
				'configure.options',
				'run.initramfs',
				'run.kvm',
				'buildBeforeRun',
			]) {
				await set(key, undefined);
			}
		}
	});
});
