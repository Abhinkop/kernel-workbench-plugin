// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): KUnit in the Testing view and Run KUnit Tests for This Directory; with
// KERNEL_E2E=1, the lib/kunit suites built and run in QEMU with kunit.py.
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { answer, api, file } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('KUnit in VS Code', function () {
	this.timeout(30 * 60 * 1000);
	let x: KernelWorkbench;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);
	const set = (key: string, value: unknown) =>
		cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
	const root = () => x.kunit.controller.items.get('kunit');

	before(async () => {
		x = await api();
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		await x.settings.select('config', 'defconfig');
	});

	after(async () => {
		await set('kunit.kunitconfig', undefined);
	});

	it('lists KUnit for the selected architecture, to be discovered by a run', async () => {
		assert.strictEqual(root()?.label, 'KUnit (x86_64)');
		assert.strictEqual(root()?.description, 'run to discover the tests');
		await x.settings.select('arch', 'arm64');
		try {
			assert.strictEqual(root()?.label, 'KUnit (arm64)');
		} finally {
			await x.settings.select('arch', 'x86_64');
		}
	});

	it('refuses to run a directory without a .kunitconfig', async () => {
		const warnings = answer('showWarningMessage', [undefined]);
		try {
			await vscode.commands.executeCommand(
				'kernelWorkbench.kunit.runDirectory',
				file('kernel/sched'),
			);
		} finally {
			warnings.restore();
		}
		assert.match(String(warnings.asked[0]?.[0]), /no \.kunitconfig/);
	});

	const e2e = process.env.KERNEL_E2E === '1' ? it : it.skip;

	e2e('runs the lib/kunit suites in QEMU, and lists them with their results', async () => {
		await set('kunit.kunitconfig', 'lib/kunit');
		await x.kunit.run(new vscode.TestRunRequest(), new vscode.CancellationTokenSource().token);
		const suites: string[] = [];
		root()?.children.forEach(suite => suites.push(suite.id));
		assert.ok(suites.includes('example'), suites.join(', '));
		assert.strictEqual(root()?.description, '');
		assert.ok(x.kunit.find('example.example_simple_test'));
		const results = JSON.parse(fs.readFileSync(x.kunit.resultsFile(), 'utf8'));
		const example = results.sub_groups.find((g: { name: string }) => g.name === 'example');
		assert.ok(
			example.test_cases.some(
				(t: { name: string; status: string }) =>
					t.name === 'example_simple_test' && t.status === 'PASS',
			),
			JSON.stringify(example),
		);
	});
});
