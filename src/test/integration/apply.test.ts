// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): the generated patch files loaded into the Apply view and applied with
// git am on a branch at the base.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { answer, api, labels, seriesBranch } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Apply in VS Code', function () {
	this.timeout(10 * 60 * 1000);
	let x: KernelWorkbench;
	const git = seriesBranch.git;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);
	const set = (key: string, value: unknown) =>
		cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
	const out = path.join(os.tmpdir(), 'kwb-it-apply', '${branch}', 'v${version}');

	before(async () => {
		x = await api();
		seriesBranch();
		git('config', 'branch.kwb-series.description', 'drm/virtio: test series');
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
		fs.rmSync(path.join(os.tmpdir(), 'kwb-it-apply'), { recursive: true, force: true });
	});

	it('applies the generated patches with git am through the Apply view', async () => {
		const output = x.series.patches.output;
		assert.ok(output);
		git('checkout', '-q', '-B', 'kwb-apply', 'kwb-base');
		const open = answer('showOpenDialog', [
			output.files.slice(1).map(f => vscode.Uri.file(path.join(output.dir, f))),
		]);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.apply.openFiles');
		} finally {
			open.restore();
		}
		const apply = x.apply.apply;
		assert.strictEqual(apply.fetched?.patches.length, 2);
		await vscode.commands.executeCommand('kernelWorkbench.apply.applyCurrent');
		assert.strictEqual(apply.message, 'Applied 2 patches.');
		assert.strictEqual(
			git('log', '-1', '--format=%s').trim(),
			'drm/virtio: add a test function',
		);
		const rows = await labels(x.apply.view);
		assert.ok(
			rows.some(r => r === 'Applied 2 patches.'),
			rows.join('\n'),
		);
	});
});
