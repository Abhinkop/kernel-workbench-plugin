// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): the Series view on a two-commit branch, checkpatch on its commits with
// the findings in Problems, and on the working changes.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, child, file, labels, seriesBranch, tree } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Series in VS Code', function () {
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
	const driver = 'drivers/gpu/drm/virtio/virtgpu_drv.c';

	before(async () => {
		x = await api();
		seriesBranch();
		await set('patches.base', 'kwb-base');
	});

	after(async () => {
		await set('patches.base', undefined);
		git('checkout', '-q', '--', '.');
	});

	it('shows the series over its base', async () => {
		await x.series.series.refresh();
		const base = git('rev-parse', 'kwb-base').trim().slice(0, 12);
		const rows = await labels(x.series.view);
		assert.ok(rows.includes(`Base — kwb-base (${base})`), rows.join('\n'));
		assert.ok(rows.includes('Commits — 2'), rows.join('\n'));
		const commits = await child(x.series.view, 'Commits');
		assert.deepStrictEqual(await labels(x.series.view, commits), [
			'drm/virtio: add a test variable — 1/2',
			'drm/virtio: add a test function — 2/2',
		]);
		await x.series.view.refresh();
		assert.strictEqual(x.series.view.view?.description, 'kwb-series · v1');
	});

	it('runs checkpatch on every commit, and puts the findings in Problems', async () => {
		await vscode.commands.executeCommand('kernelWorkbench.series.check');
		const commits = await child(x.series.view, 'Commits');
		const rows = await labels(x.series.view, commits);
		assert.match(rows[0], /^drm\/virtio: add a test variable — 1\/2 · \d+ errors?/);
		const problems = vscode.languages
			.getDiagnostics(file(driver))
			.filter(d => String(d.source).startsWith('checkpatch'));
		assert.ok(
			problems.some(d => d.code === 'GLOBAL_INITIALISERS'),
			problems.map(d => String(d.code)).join(','),
		);
		const text = fs.readFileSync(path.join(tree(), driver), 'utf8').split('\n');
		assert.match(text[problems[0].range.start.line], /kwb_test_var/, 'on the right line');
		assert.ok(x.series.series.lastBuild, 'the build checks ran or said why not');
	});

	it('checks the working changes', async () => {
		const f = path.join(tree(), 'kernel/sched/topology.c');
		fs.appendFileSync(f, '\nstatic int  kwb( void ) { return 0 ; }\n');
		try {
			await vscode.commands.executeCommand('kernelWorkbench.series.checkWorking');
		} finally {
			git('checkout', '-q', '--', 'kernel/sched/topology.c');
		}
		const working = x.series.series.working;
		assert.ok(working && working.errors > 0, JSON.stringify(working));
		const rows = await labels(x.series.view);
		assert.ok(
			rows.some(r => /^Working changes — \d+ errors?/.test(r)),
			rows.join('\n'),
		);
	});
});
