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

/** git with a fixed identity, and without the developer's own configuration. */
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 'Test Author',
	GIT_AUTHOR_EMAIL: 'author@example.com',
	GIT_COMMITTER_NAME: 'Test Author',
	GIT_COMMITTER_EMAIL: 'author@example.com',
	GIT_CONFIG_NOSYSTEM: '1',
	HOME: os.tmpdir(),
};

/** A throwaway git repository. */
export class Repo {
	constructor(readonly dir: string) {}

	git(...args: string[]): string {
		return childProcess.execFileSync('git', args, {
			cwd: this.dir,
			env: GIT_ENV,
			encoding: 'utf8',
		});
	}

	write(file: string, text: string): void {
		const p = path.join(this.dir, file);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, text);
	}

	read(file: string): string {
		return fs.readFileSync(path.join(this.dir, file), 'utf8');
	}

	/** Writes (or, for null, removes) the files and commits them; returns the new hash. */
	commit(message: string, files: Record<string, string | null> = {}, date?: string): string {
		for (const [file, text] of Object.entries(files)) {
			if (text === null) {
				fs.rmSync(path.join(this.dir, file));
			} else {
				this.write(file, text);
			}
		}
		this.git('add', '-A');
		const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
		childProcess.execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
			cwd: this.dir,
			env: { ...GIT_ENV, ...env },
		});
		return this.git('rev-parse', 'HEAD').trim();
	}

	remove(): void {
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}

/** A new repository with a kernel Makefile committed, so it looks like a kernel tree. */
export function makeRepo(): Repo {
	const repo = new Repo(fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-repo-')));
	repo.git('init', '-q', '-b', 'master');
	repo.git('config', 'user.name', 'Test Author');
	repo.git('config', 'user.email', 'author@example.com');
	repo.commit('Initial', { Makefile: KERNEL_MAKEFILE });
	return repo;
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
