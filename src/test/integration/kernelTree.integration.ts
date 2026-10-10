// Integration tests for the kernel-tree check, run against a real kernel clone with real git.
// Run them with the "npm: test:integration" task, which passes the kernelWorkbench.dev.kernelTree
// setting in KERNEL_TREE; CI sets KERNEL_TREE to its own clone. The tree must be a full clone
// (not --depth 1) so that it contains the mainline root commit.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { getKernelVersion, isKernelTree, isLinuxKernelRepo } from '../../kernelTree';

describe('a real kernel clone', () => {
	const kernelTree = process.env.KERNEL_TREE ?? '';

	before(() => {
		if (!kernelTree) {
			throw new Error(
				'KERNEL_TREE is not set. Set kernelWorkbench.dev.kernelTree in ' +
					'.vscode/settings.json and run the "npm: test:integration" task.',
			);
		}
	});

	it('is a kernel tree', () => {
		assert.equal(isKernelTree(kernelTree), true);
	});

	it('has the version `make kernelversion` prints', () => {
		const expected = execFileSync('make', ['-s', 'kernelversion'], { cwd: kernelTree })
			.toString()
			.trim();
		assert.equal(getKernelVersion(kernelTree), expected);
	});

	it('is a Linux repo from a subfolder too', () => {
		// git searches upward from the working directory for the repository.
		assert.equal(isLinuxKernelRepo(path.join(kernelTree, 'kernel')), true);
	});
});
