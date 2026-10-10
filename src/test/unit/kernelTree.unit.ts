// Unit tests for the kernel-tree check. They need no VS Code:
//   npm run test:unit
import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	getKernelVersion,
	isKernelTree,
	isLinuxKernelRepo,
	LINUX_ROOT_COMMIT,
} from '../../kernelTree';
// The module object itself, not an `import * as` copy, so that mocking execSync on it
// replaces the execSync that kernelTree calls.
import childProcess = require('child_process');

/** The opening lines of a real kernel's top-level Makefile. */
const KERNEL_MAKEFILE = [
	'# SPDX-License-Identifier: GPL-2.0',
	'VERSION = 6',
	'PATCHLEVEL = 12',
	'SUBLEVEL = 0',
	'EXTRAVERSION =',
	'NAME = Baby Opossum Posse',
	'',
].join('\n');

/** A new empty folder holding the given files, mapped from name to contents. */
function folderWith(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-dev-test-'));
	for (const [name, contents] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), contents);
	}
	return dir;
}

/** Makes git report that the Linux root commit exists, as it does in a kernel clone. */
function inLinuxRepo(t: TestContext): void {
	t.mock.method(childProcess, 'execSync', () => Buffer.from('commit\n'));
}

/** Makes git fail, as it does outside a repo or when the root commit is missing. */
function notInLinuxRepo(t: TestContext): void {
	t.mock.method(childProcess, 'execSync', () => {
		throw new Error('fatal: Not a valid object name');
	});
}

test('the version of a kernel tree is read from its Makefile', () => {
	assert.equal(getKernelVersion(folderWith({ Makefile: KERNEL_MAKEFILE })), '6.12.0');
});

test('EXTRAVERSION is appended to the version', () => {
	const makefile = KERNEL_MAKEFILE.replace('EXTRAVERSION =', 'EXTRAVERSION = -rc5');
	assert.equal(getKernelVersion(folderWith({ Makefile: makefile })), '6.12.0-rc5');
});

test('an empty SUBLEVEL is left out of the version', () => {
	const makefile = 'VERSION = 2\nPATCHLEVEL = 6\nSUBLEVEL =\n';
	assert.equal(getKernelVersion(folderWith({ Makefile: makefile })), '2.6');
});

test('a Linux repo with a kernel Makefile is a kernel tree', t => {
	inLinuxRepo(t);
	assert.equal(isKernelTree(folderWith({ Makefile: KERNEL_MAKEFILE })), true);
});

test('a kernel Makefile outside a Linux repo is not a kernel tree', t => {
	// For example, source unpacked from a kernel.org tarball.
	notInLinuxRepo(t);
	assert.equal(isKernelTree(folderWith({ Makefile: KERNEL_MAKEFILE })), false);
});

test('a Linux repo without a kernel Makefile is not a kernel tree', t => {
	inLinuxRepo(t);
	assert.equal(isKernelTree(folderWith({ Makefile: 'all:\n' })), false);
});

test('Kbuild and Kconfig without a kernel Makefile are not enough', t => {
	inLinuxRepo(t);
	// VS Code activates the extension on Kbuild alone (workspaceContains:Kbuild),
	// so this check is what keeps such folders from being treated as kernel trees.
	const dir = folderWith({ Kbuild: '', Kconfig: '' });
	assert.equal(getKernelVersion(dir), undefined);
	assert.equal(isKernelTree(dir), false);
});

test('an ordinary Makefile is not a kernel Makefile', () => {
	const dir = folderWith({ Makefile: 'all:\n\tcc -o hello hello.c\n' });
	assert.equal(getKernelVersion(dir), undefined);
	assert.equal(isKernelTree(dir), false);
});

test('VERSION without PATCHLEVEL is not enough', () => {
	assert.equal(getKernelVersion(folderWith({ Makefile: 'VERSION = 6\n' })), undefined);
});

test('an empty VERSION is not enough', () => {
	const makefile = 'VERSION =\nPATCHLEVEL = 12\n';
	assert.equal(getKernelVersion(folderWith({ Makefile: makefile })), undefined);
});

test('EXTRAVERSION does not count as VERSION', () => {
	const makefile = 'EXTRAVERSION = -rc5\nPATCHLEVEL = 12\n';
	assert.equal(getKernelVersion(folderWith({ Makefile: makefile })), undefined);
});

test('version lines past the first 500 bytes are not found', () => {
	const makefile = '#'.repeat(600) + '\n' + KERNEL_MAKEFILE;
	assert.equal(getKernelVersion(folderWith({ Makefile: makefile })), undefined);
});

test('a directory named Makefile is not a kernel tree', () => {
	const dir = folderWith({});
	fs.mkdirSync(path.join(dir, 'Makefile'));
	assert.equal(getKernelVersion(dir), undefined);
	assert.equal(isKernelTree(dir), false);
});

test('a folder that does not exist is not a kernel tree', () => {
	const dir = path.join(os.tmpdir(), 'kernel-dev-test-does-not-exist');
	assert.equal(getKernelVersion(dir), undefined);
	assert.equal(isKernelTree(dir), false);
});

test('isLinuxKernelRepo asks git, in dir, for the type of the Linux root commit', t => {
	const execSync = t.mock.method(childProcess, 'execSync', () => Buffer.from('commit\n'));
	isLinuxKernelRepo('/src/linux');
	assert.equal(execSync.mock.callCount(), 1);
	const [command, options] = execSync.mock.calls[0].arguments as [
		string,
		childProcess.ExecSyncOptions,
	];
	assert.equal(command, `git cat-file -t ${LINUX_ROOT_COMMIT}`);
	assert.equal(options.cwd, '/src/linux');
});

test('a repo containing the Linux root commit is a Linux repo', t => {
	inLinuxRepo(t);
	assert.equal(isLinuxKernelRepo('/src/linux'), true);
});

test('an object of another type under that hash is not a Linux repo', t => {
	t.mock.method(childProcess, 'execSync', () => Buffer.from('blob\n'));
	assert.equal(isLinuxKernelRepo('/src/linux'), false);
});

test('a folder where git fails is not a Linux repo', t => {
	// Not a git repo, no root commit, no such folder, or git not installed.
	notInLinuxRepo(t);
	assert.equal(isLinuxKernelRepo('/src/linux'), false);
});
