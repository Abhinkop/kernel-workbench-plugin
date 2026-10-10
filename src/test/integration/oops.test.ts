// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): Decode Stack Trace on a selected trace, with its tab, links and Problems
// entries; with KERNEL_E2E=1, the booted kernel crashed with sysrq, noticed in the console
// and decoded with the build's vmlinux.
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { answer, api, busyboxInitramfs, file, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Kernel crashes in VS Code', function () {
	this.timeout(30 * 60 * 1000);
	let x: KernelWorkbench;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);
	const set = (key: string, value: unknown) =>
		cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
	const trace = [
		'[    7.765288] Kernel panic - not syncing: sysrq triggered crash',
		'[    7.768643]  dump_stack_lvl (lib/dump_stack.c:94)',
		'[    7.769682]  sysrq_handle_crash (drivers/tty/sysrq.c:154)',
		'[    7.780000] ---[ end Kernel panic - not syncing: sysrq triggered crash ]---',
		'',
	].join('\n');

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
		for (const key of ['buildBeforeRun', 'run.initramfs', 'run.kvm']) {
			await set(key, undefined);
		}
	});

	it('decodes a selected trace into a tab with links, and Problems', async () => {
		fs.writeFileSync(file('kwb-trace.txt').fsPath, trace);
		try {
			const document = await vscode.workspace.openTextDocument(file('kwb-trace.txt'));
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(0, 0, document.lineCount, 0);
			await vscode.commands.executeCommand('kernelWorkbench.oops.decode');
			const shown = vscode.window.activeTextEditor;
			assert.strictEqual(shown?.document.uri.scheme, 'kernel-oops');
			const text = shown.document.getText();
			assert.match(text, /^Kernel panic - not syncing: sysrq triggered crash\n/);
			assert.match(text, /^2 frames with source locations/m);
			assert.match(text, /sysrq_handle_crash \(drivers\/tty\/sysrq\.c:154\)/);
			const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
				'vscode.executeLinkProvider',
				shown.document.uri,
			);
			const sysrq = file('drivers/tty/sysrq.c');
			assert.ok(
				links.some(l => l.target?.fsPath === sysrq.fsPath && l.target.fragment === 'L154'),
				links.map(l => String(l.target)).join(', '),
			);
			const problems = vscode.languages.getDiagnostics(sysrq);
			assert.ok(
				problems.some(
					d =>
						d.source === 'oops' &&
						d.range.start.line === 153 &&
						d.severity === vscode.DiagnosticSeverity.Information &&
						/frame 1: sysrq_handle_crash/.test(d.message),
				),
				problems.map(d => d.message).join(', '),
			);
			assert.ok(
				vscode.languages
					.getDiagnostics(file('lib/dump_stack.c'))
					.some(d => d.severity === vscode.DiagnosticSeverity.Error),
				'the first frame is the error',
			);
		} finally {
			fs.rmSync(file('kwb-trace.txt').fsPath, { force: true });
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		}
	});

	const e2e = process.env.KERNEL_E2E === '1' ? it : it.skip;

	e2e('notices a crash in the VM console, and decodes it with the build', async () => {
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.build'), 0);
		await set('buildBeforeRun', false);
		await set('run.initramfs', { x86_64: busyboxInitramfs() });
		await set('run.kvm', fs.existsSync('/dev/kvm') ? 'auto' : 'off');
		const recorded = x.settings.configured();
		assert.ok(recorded);
		const log = x.runner.consoleLog(recorded);
		const show = answer('showErrorMessage', ['Show Decoded Trace']);
		const reports = x.oops.count;
		try {
			await vscode.commands.executeCommand('kernelWorkbench.run');
			assert.strictEqual(x.oops.watching, log);
			await until(
				() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('KWB-INIT-RAN'),
				180000,
				200,
			);
			x.runner.vm?.sendText('echo c > /proc/sysrq-trigger');
			await until(() => show.asked.length > 0, 60000, 100);
			await until(() => x.oops.count > reports, 60000, 100);
		} finally {
			show.restore();
			await vscode.commands.executeCommand('kernelWorkbench.stop');
		}
		assert.match(String(show.asked[0]?.[0]), /sysrq triggered crash/);
		const decoded = x.oops.reports.get(String(x.oops.count));
		assert.ok(decoded);
		assert.match(decoded, /sysrq_handle_crash \(drivers\/tty\/sysrq\.c:\d+\)/);
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.scheme, 'kernel-oops');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});
});
