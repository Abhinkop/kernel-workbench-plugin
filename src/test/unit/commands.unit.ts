// Every command package.json contributes is registered by activate(), and
// every command activate() registers is contributed.
import { stub, fakeContext, folder } from './vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { activate } from '../../extension';
// The module object itself, so that mocking execSync on it replaces the
// execSync that kernelTree calls.
import childProcess = require('child_process');

const pkg = JSON.parse(
	fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
);

test('contributed and registered commands match', t => {
	// A kernel tree: a kernel Makefile, and git reporting the Linux root commit.
	const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-workbench-tree-'));
	fs.writeFileSync(path.join(tree, 'Makefile'), 'VERSION = 6\nPATCHLEVEL = 12\nSUBLEVEL = 0\n');
	t.mock.method(childProcess, 'execSync', () => Buffer.from('commit\n'));
	stub.workspaceFolders = [folder(tree)];
	stub.registeredCommands = [];

	activate(fakeContext());

	const contributed = ((pkg.contributes?.commands ?? []) as { command: string }[])
		.map(c => c.command)
		.sort();
	assert.ok(contributed.length > 0);
	assert.deepEqual([...stub.registeredCommands].sort(), contributed);
});
