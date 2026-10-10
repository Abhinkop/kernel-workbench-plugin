// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): recipients from the tree's get_maintainer.pl, and the series generated
// with git format-patch once its checkpatch errors are acknowledged.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { answer, api, child, labels, seriesBranch } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Patches in VS Code', function () {
	this.timeout(10 * 60 * 1000);
	let x: KernelWorkbench;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);
	const set = (key: string, value: unknown) =>
		cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
	const out = path.join(os.tmpdir(), 'kwb-it-patches', '${branch}', 'v${version}');

	before(async () => {
		x = await api();
		seriesBranch();
		await set('patches.base', 'kwb-base');
		await set('patches.outputDirectory', out);
		await x.series.series.refresh();
	});

	after(async () => {
		await set('patches.base', undefined);
		await set('patches.outputDirectory', undefined);
		fs.rmSync(path.join(os.tmpdir(), 'kwb-it-patches'), { recursive: true, force: true });
	});

	it('fills the recipients from get_maintainer.pl', async () => {
		await vscode.commands.executeCommand('kernelWorkbench.series.fillRecipients');
		const patches = x.series.patches;
		assert.ok(
			patches.to.some(a => /airlied@redhat\.com/.test(a)),
			patches.to.join(', '),
		);
		assert.ok(
			patches.cc.some(a => /dri-devel/.test(a)),
			patches.cc.join(', '),
		);
		const group = await child(x.series.view, 'Patches');
		const rows = await labels(x.series.view, group);
		assert.ok(
			rows.some(r => /^To — \d+$/.test(r)),
			rows.join('\n'),
		);
	});

	it('generates the series only after the checkpatch errors are acknowledged', async () => {
		seriesBranch.git(
			'config',
			'branch.kwb-series.description',
			'drm/virtio: test series\n\nTwo patches made by the integration tests.',
		);
		const refused = answer('showWarningMessage', [undefined]);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.series.generate');
		} finally {
			refused.restore();
		}
		assert.match(
			String(refused.asked[0]?.[0]),
			/checkpatch reports \d+ errors? in 1 of 2 commits/,
		);
		// Another test file may have generated into its own directory before: check ours.
		const generated = () => x.series.patches.output;
		assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'kwb-it-patches')), 'nothing written');
		const go = answer('showWarningMessage', ['Generate Anyway', 'Replace Them']);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.series.generate');
		} finally {
			go.restore();
		}
		const output = generated();
		assert.ok(output);
		assert.deepStrictEqual(output.files, [
			'0000-cover-letter.patch',
			'0001-drm-virtio-add-a-test-variable.patch',
			'0002-drm-virtio-add-a-test-function.patch',
		]);
		assert.match(
			fs.readFileSync(path.join(output.dir, output.files[0]), 'utf8'),
			/^Subject: \[PATCH 0\/2\] drm\/virtio: test series$/m,
		);
		const group = await child(x.series.view, 'Patches');
		const rows = await labels(x.series.view, group);
		assert.ok(
			rows.some(r => r.startsWith('Generated — ')),
			rows.join('\n'),
		);
	});
});
