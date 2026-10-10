// KUnit in the Testing view: the failures in kunit.py's output, the architectures it knows,
// the kunit.py command, the results reported, and Run KUnit Tests for This Directory.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { fakeGit, kernelTree } from '../helpers/repo';
import { activate } from '../../extension';
import { failures, KUNIT_ARCH, registerKunit } from '../../kunit';
import { Settings } from '../../settings';

const pkg = JSON.parse(
	fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
);

describe('kunit', () => {
	/** A kunit.py stand-in: writes JSON results, prints a failure, and fails. */
	const KUNIT_PY = [
		'import json, sys',
		"out = [a.split('=', 1)[1] for a in sys.argv if a.startswith('--json=')][0]",
		"json.dump({'name': 'all', 'sub_groups': [{'name': 'suite', 'test_cases': [",
		"    {'name': 'ok', 'status': 'PASS'}, {'name': 'bad', 'status': 'FAIL'},",
		"    {'name': 'sk', 'status': 'SKIP'}]}]}, open(out, 'w'))",
		"print('    # bad: EXPECTATION FAILED at lib/x.c:7')",
		"print('[FAILED] bad')",
		"print('ARGS', ' '.join(sys.argv[1:]))",
		'sys.exit(1)',
		'',
	].join('\n');
	const treeWithKunit = () => {
		const root = kernelTree();
		fs.mkdirSync(path.join(root, 'tools/testing/kunit'), { recursive: true });
		fs.writeFileSync(path.join(root, 'tools/testing/kunit/kunit.py'), KUNIT_PY);
		return root;
	};
	const request = (...items: vscodeTypes.TestItem[]) =>
		new vscode.TestRunRequest(
			items.length ? items : undefined,
		) as unknown as vscodeTypes.TestRunRequest;
	const token = () =>
		new vscode.CancellationTokenSource().token as unknown as vscodeTypes.CancellationToken;
	const lastTaskCommand = () => String(state.tasks.pop()?.execution.args[1]);

	it('extracts failure details and locations from kunit.py output', () => {
		const out = [
			'[10:01:20] ============ example (3 subtests) ============',
			'[10:01:20] [PASSED] example_skip_test',
			'[10:01:20]     # example_simple_test: initializing',
			'[10:01:20]     # example_simple_test: EXPECTATION FAILED at ' +
				'lib/kunit/kunit-example-test.c:30',
			'[10:01:20]     Expected 1 + 1 == 3, but',
			'[10:01:20] [FAILED] example_simple_test',
			'[10:01:20] [FAILED] no_location_test',
		].join('\n');
		const found = failures(out);
		const simple = found.get('example_simple_test');
		assert.deepEqual([simple?.file, simple?.line], ['lib/kunit/kunit-example-test.c', 30]);
		assert.match(String(simple?.log), /Expected 1 \+ 1 == 3/);
		assert.equal(found.get('no_location_test')?.file, undefined);
	});

	it('maps architectures to kunit.py names', () => {
		assert.deepEqual(KUNIT_ARCH, { x86_64: 'x86_64', arm64: 'arm64', riscv64: 'riscv' });
	});

	it('builds the kunit.py command, runs it and reports results', async () => {
		const root = treeWithKunit();
		const settings = new Settings(extensionContext(), workspaceFolder(root));
		state.config['kernelWorkbench.kunit.kunitconfig'] = 'lib/kunit';
		const kunit = registerKunit(extensionContext(), settings);
		const rootItem = kunit.controller.items.get('kunit');
		assert.equal(rootItem?.label, `KUnit (${settings.arch})`);
		assert.equal(rootItem?.description, 'run to discover the tests');
		await kunit.run(request(), token());
		const run = state.testRuns.pop();
		assert.ok(run);
		assert.deepEqual(Object.fromEntries(run.results.map(r => [r[1], r[0]])), {
			'suite.ok': 'passed',
			'suite.bad': 'failed',
			'suite.sk': 'skipped',
		});
		const failed = run.results.find(r => r[0] === 'failed')?.[2] as vscodeTypes.TestMessage;
		assert.equal(failed.location?.range.start.line, 6);
		assert.match(
			lastTaskCommand(),
			/kunit\.py run --arch=\w+ --build_dir=\S+ .*--kunitconfig=lib\/kunit 2>&1/,
		);
		// The tree now lists the suite and its cases.
		assert.ok(kunit.find('suite.bad'));
		assert.equal(kunit.controller.items.get('kunit')?.description, '');
		// A filtered run of one suite.
		const suite = kunit.find('suite');
		assert.ok(suite);
		await kunit.run(request(suite), token());
		assert.match(lastTaskCommand(), / suite 2>&1/);
	});

	it('runs the nearest .kunitconfig for a directory, or says there is none', async () => {
		const git = fakeGit('commit');
		try {
			const root = treeWithKunit();
			fs.mkdirSync(path.join(root, 'lib/kunit'), { recursive: true });
			fs.writeFileSync(path.join(root, 'lib/kunit/.kunitconfig'), 'CONFIG_KUNIT=y\n');
			fs.writeFileSync(path.join(root, 'lib/kunit/test.c'), '');
			vscode.workspace.workspaceFolders = [workspaceFolder(root)];
			const api = activate(extensionContext());
			assert.ok(api);
			await vscode.commands.executeCommand(
				'kernelWorkbench.kunit.runDirectory',
				vscode.Uri.file(path.join(root, 'Makefile')),
			);
			assert.match(String(state.log.pop()?.message), /no \.kunitconfig/);
			assert.equal(state.tasks.length, 0);
			await vscode.commands.executeCommand(
				'kernelWorkbench.kunit.runDirectory',
				vscode.Uri.file(path.join(root, 'lib/kunit/test.c')),
			);
			assert.match(lastTaskCommand(), /--kunitconfig=lib\/kunit /);
			assert.equal(api.kunit.find('suite.ok')?.label, 'ok');
			// Changing the architecture reloads the tree for it.
			await api.settings.select('arch', 'arm64');
			assert.equal(api.kunit.controller.items.get('kunit')?.label, 'KUnit (arm64)');
		} finally {
			git.restore();
		}
		const menus = pkg.contributes.menus;
		const inExplorerMenu = menus['kernelWorkbench.explorerContext'].find(
			(m: { command: string }) => m.command === 'kernelWorkbench.kunit.runDirectory',
		);
		assert.equal(inExplorerMenu?.group, '2_build@2');
		assert.ok(
			menus.commandPalette.some(
				(m: { command: string }) => m.command === 'kernelWorkbench.kunit.runDirectory',
			),
		);
	});
});
