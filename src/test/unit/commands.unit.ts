// activate(): nothing outside a kernel tree; in one, exactly the commands
// package.json contributes, and the kernelWorkbench.active context key.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { fakeGit, kernelTree, tempDir } from '../helpers/repo';
import { activate } from '../../extension';

const pkg = JSON.parse(
	fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
);

describe('activate', () => {
	let git: ReturnType<typeof fakeGit>;
	beforeEach(() => (git = fakeGit('commit')));
	afterEach(() => git.restore());

	const setContext = (key: string) =>
		state.executed.find(e => e.id === 'setContext' && e.args[0] === key)?.args[1];

	it('does nothing outside a kernel tree', () => {
		vscode.workspace.workspaceFolders = [workspaceFolder(tempDir())];
		activate(extensionContext());
		assert.equal(state.commands.size, 0);
		assert.equal(setContext('kernelWorkbench.active'), undefined);
	});

	it('registers exactly the commands the manifest contributes', () => {
		vscode.workspace.workspaceFolders = [workspaceFolder(kernelTree())];
		activate(extensionContext());
		const contributed = ((pkg.contributes?.commands ?? []) as { command: string }[])
			.map(c => c.command)
			.sort();
		assert.ok(contributed.length > 0);
		assert.deepEqual([...state.commands.keys()].sort(), contributed);
		assert.equal(setContext('kernelWorkbench.active'), true);
	});
});
