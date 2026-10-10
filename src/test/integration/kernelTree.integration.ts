// Integration tests for the kernel-tree check, run against a real kernel clone with real git:
//   KERNEL_TREE=/path/to/linux npm run test:integration
// KERNEL_TREE must be a full clone (not --depth 1) so that it contains the mainline root commit.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { getKernelVersion, isKernelTree, isLinuxKernelRepo } from '../../kernelTree';

const kernelTree = process.env.KERNEL_TREE;
if (!kernelTree) {
	throw new Error('Set KERNEL_TREE to a full clone of the Linux kernel.');
}

test('the kernel clone is a kernel tree', () => {
	assert.equal(isKernelTree(kernelTree), true);
});

test('the version matches `make kernelversion`', () => {
	const expected = execFileSync('make', ['-s', 'kernelversion'], { cwd: kernelTree })
		.toString()
		.trim();
	assert.equal(getKernelVersion(kernelTree), expected);
});

test('a subfolder of the kernel clone is in a Linux repo', () => {
	// git searches upward from the working directory for the repository.
	assert.equal(isLinuxKernelRepo(path.join(kernelTree, 'kernel')), true);
});
