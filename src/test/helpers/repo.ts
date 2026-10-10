// Throwaway folders and kernel trees for tests.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// The module object itself, not an `import * as` copy, so that replacing
// execSync on it replaces the execSync that kernelTree calls.
import childProcess = require('child_process');

/** The opening lines of a real kernel's top-level Makefile. */
export const KERNEL_MAKEFILE = [
	'# SPDX-License-Identifier: GPL-2.0',
	'VERSION = 6',
	'PATCHLEVEL = 12',
	'SUBLEVEL = 0',
	'EXTRAVERSION =',
	'NAME = Baby Opossum Posse',
	'',
].join('\n');

export function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-tmp-'));
}

/** A new folder holding the given files, mapped from name to contents. */
export function folderWith(files: Record<string, string>): string {
	const dir = tempDir();
	for (const [name, contents] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), contents);
	}
	return dir;
}

/** A new folder with a kernel Makefile, so it looks like a kernel tree. */
export function kernelTree(files: Record<string, string> = {}): string {
	return folderWith({ Makefile: KERNEL_MAKEFILE, ...files });
}

/** What git was asked to run, and where. */
export interface GitCall {
	command: string;
	cwd: string | undefined;
}

/**
 * Replace execSync, which kernelTree uses to ask git for the type of the
 * Linux root commit, until restore(): it answers `type` ('commit' in a
 * kernel clone), or fails as git does outside a repository when `type` is
 * undefined.
 */
export function fakeGit(type: string | undefined): { calls: GitCall[]; restore(): void } {
	const calls: GitCall[] = [];
	const original = childProcess.execSync;
	const execSync = (command: string, options?: { cwd?: string | URL }) => {
		calls.push({ command, cwd: options?.cwd?.toString() });
		if (type === undefined) {
			throw new Error('fatal: Not a valid object name');
		}
		return Buffer.from(`${type}\n`);
	};
	Object.assign(childProcess, { execSync });
	return { calls, restore: () => Object.assign(childProcess, { execSync: original }) };
}
