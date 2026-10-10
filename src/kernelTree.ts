import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/** How much of the Makefile to read; the version variables are in its first few lines. */
const HEADER_BYTES = 500;

/**
 * The first commit in Linus Torvalds' mainline history (Linux 2.6.12-rc2, April 2005). Every
 * full clone of the kernel, and of any tree forked from it, contains this commit.
 */
export const LINUX_ROOT_COMMIT = "1da177e4c3f41524e886b7f1b8a0c1fc7321cac2";

/**
 * A Linux kernel source tree is one whose top-level Makefile gives a kernel version and
 * whose git history contains the mainline root commit.
 */
export function isKernelTree(dir: string): boolean {
	return getKernelVersion(dir) !== undefined && isLinuxKernelRepo(dir);
}

/**
 * Whether dir is in a git repository that contains LINUX_ROOT_COMMIT. False for shallow clones
 * (the root commit is not fetched) and for source unpacked from a tarball (no git repository).
 */
export function isLinuxKernelRepo(dir: string): boolean {
	try {
		// `git cat-file -t` prints the object's type ("commit") if the object exists, and exits
		// non-zero if it does not or if dir is not in a git repository. Like any git command, it
		// searches upward from dir for the repository.
		const output = execSync(`git cat-file -t ${LINUX_ROOT_COMMIT}`, {
			cwd: dir,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.toString().trim() === "commit";
	} catch {
		// Not a git repository, no such commit, dir does not exist, or git is not installed.
		return false;
	}
}

/**
 * The kernel version set at the top of dir/Makefile, formatted as `make kernelversion` does
 * (e.g. "6.12.0-rc5"), or undefined if dir is not a kernel tree.
 */
export function getKernelVersion(dir: string): string | undefined {
	const header = readMakefileHeader(path.join(dir, "Makefile"));
	if (header === undefined) {
		return undefined;
	}

	const version = makeVariable(header, "VERSION");
	const patchlevel = makeVariable(header, "PATCHLEVEL");
	if (!version || !patchlevel) {
		return undefined;
	}
	const sublevel = makeVariable(header, "SUBLEVEL");
	const extraversion = makeVariable(header, "EXTRAVERSION") ?? "";
	return `${version}.${patchlevel}${sublevel ? `.${sublevel}` : ""}${extraversion}`;
}

/** The first HEADER_BYTES of a file, or undefined if it cannot be read. */
function readMakefileHeader(makefilePath: string): string | undefined {
	try {
		// Read only the head of the Makefile rather than loading the whole file.
		const fd = fs.openSync(makefilePath, "r");
		try {
			const buffer = Buffer.alloc(HEADER_BYTES);
			const bytesRead = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
			return buffer.toString("utf8", 0, bytesRead);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/** The value of a `NAME = value` line, anchored to the line start so EXTRAVERSION ≠ VERSION. */
function makeVariable(content: string, name: string): string | undefined {
	return new RegExp(`^${name} =[ \\t]*(.*?)[ \\t]*$`, "m").exec(content)?.[1];
}
