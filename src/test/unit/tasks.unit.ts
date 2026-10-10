// Steps run as VS Code tasks: the exit code comes back, and the terminal
// closes when the step succeeds unless kernelWorkbench.terminal.afterTask is
// "keep"; a failed step's terminal stays.
import * as assert from 'node:assert/strict';
import * as os from 'os';
import { state, vscode, workspaceFolder } from '../helpers/vscode';
import { makeTask, runTask, sq } from '../../tasks';

describe('tasks', () => {
	const folder = () => workspaceFolder(os.tmpdir());

	it('quotes for the shell', () => {
		assert.equal(sq('make'), 'make');
		assert.equal(sq('O=/a b'), "'O=/a b'");
		assert.equal(sq("it's"), "'it'\\''s'");
	});

	it('runs a process as a task and returns its exit code', async () => {
		assert.equal(await runTask(folder(), 'ok', 'sh', ['-c', 'exit 0']), 0);
		assert.equal(await runTask(folder(), 'fail', 'sh', ['-c', 'exit 3']), 3);
	});

	it('closes the terminal of a step that succeeded, and keeps a failed one', async () => {
		const task = makeTask(folder(), 'x', 'true', []);
		assert.equal(
			task.presentationOptions?.close,
			false,
			'VS Code would close it on failure too',
		);
		assert.equal(task.source, 'kernel');
		const open = () => vscode.window.terminals.map(t => t.name);
		await runTask(folder(), 'good', 'sh', ['-c', 'exit 0']);
		await runTask(folder(), 'bad', 'sh', ['-c', 'exit 2']);
		assert.deepEqual(open(), ['bad']);
		state.config['kernelWorkbench.terminal.afterTask'] = 'keep';
		await runTask(folder(), 'kept', 'sh', ['-c', 'exit 0']);
		assert.deepEqual(open(), ['bad', 'kept']);
	});
});
