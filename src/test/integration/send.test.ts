// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): the generated series dry-run with git send-email, which alone enables
// Send, and Send declined.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { answer, api, labels, seriesBranch } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Sending patches in VS Code', function () {
	this.timeout(10 * 60 * 1000);
	let x: KernelWorkbench;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);
	const set = (key: string, value: unknown) =>
		cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
	const out = path.join(os.tmpdir(), 'kwb-it-send', '${branch}', 'v${version}');

	before(async () => {
		x = await api();
		seriesBranch();
		seriesBranch.git('config', 'branch.kwb-series.description', 'drm/virtio: test series');
		await set('patches.base', 'kwb-base');
		await set('patches.outputDirectory', out);
		await x.series.series.refresh();
		const go = answer('showWarningMessage', ['Generate Anyway', 'Replace Them']);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.series.generate');
		} finally {
			go.restore();
		}
		assert.strictEqual(x.series.patches.output?.files.length, 3);
	});

	after(async () => {
		await set('patches.base', undefined);
		await set('patches.outputDirectory', undefined);
		fs.rmSync(path.join(os.tmpdir(), 'kwb-it-send'), { recursive: true, force: true });
	});

	it('refuses to send before a dry run, and offers Dry run once generated', async () => {
		const errors = answer('showErrorMessage', [undefined]);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.series.send');
		} finally {
			errors.restore();
		}
		assert.match(String(errors.asked[0]?.[0]), /run a dry run of these exact files first/);
		await x.series.view.refresh();
		const actions = await labels(x.series.view, (await x.series.view.getChildren())[0]);
		assert.ok(
			actions.some(a => a.startsWith('Dry run — ')),
			actions.join('\n'),
		);
		assert.ok(!actions.some(a => a.startsWith('Send…')));
	});

	it('dry-runs git send-email, and only then enables Send', async function () {
		const sender = x.series.sender;
		const errors = answer('showErrorMessage', [undefined]);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.series.dryRun');
		} finally {
			errors.restore();
		}
		if (!sender.dry) {
			assert.match(String(errors.asked[0]?.[0]), /git send-email is not installed/);
			this.skip(); // git send-email is not installed here
		}
		assert.ok(sender.dry.ok, 'dry run OK');
		assert.strictEqual(sender.dry.mails.length, 3);
		assert.ok(sender.dryRunCurrent());
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.scheme, 'untitled');
		const declined = answer('showWarningMessage', [undefined]);
		const terminals = vscode.window.terminals.length;
		try {
			await vscode.commands.executeCommand('kernelWorkbench.series.send');
		} finally {
			declined.restore();
		}
		assert.match(String(declined.asked[0]?.[0]), /^Send 3 mails to \d+ addresses\?$/);
		assert.strictEqual(vscode.window.terminals.length, terminals, 'declined: nothing sent');
	});
});
