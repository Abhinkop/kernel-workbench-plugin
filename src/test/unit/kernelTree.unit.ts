// The kernel-tree check: the version read from the top-level Makefile, and
// git asked for the Linux root commit.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fakeGit, folderWith, KERNEL_MAKEFILE, kernelTree } from '../helpers/repo';
import {
	getKernelVersion,
	isKernelTree,
	isLinuxKernelRepo,
	LINUX_ROOT_COMMIT,
} from '../../kernelTree';

describe('kernel tree detection', () => {
	let git: ReturnType<typeof fakeGit> | undefined;
	afterEach(() => git?.restore());

	describe('the version in the Makefile', () => {
		it('is read from a kernel Makefile', () => {
			assert.equal(getKernelVersion(kernelTree()), '6.12.0');
		});

		it('has EXTRAVERSION appended', () => {
			const makefile = KERNEL_MAKEFILE.replace('EXTRAVERSION =', 'EXTRAVERSION = -rc5');
			assert.equal(getKernelVersion(folderWith({ Makefile: makefile })), '6.12.0-rc5');
		});

		it('leaves out an empty SUBLEVEL', () => {
			const makefile = 'VERSION = 2\nPATCHLEVEL = 6\nSUBLEVEL =\n';
			assert.equal(getKernelVersion(folderWith({ Makefile: makefile })), '2.6');
		});

		it('is undefined for an ordinary Makefile', () => {
			const dir = folderWith({ Makefile: 'all:\n\tcc -o hello hello.c\n' });
			assert.equal(getKernelVersion(dir), undefined);
		});

		it('needs both VERSION and PATCHLEVEL, non-empty', () => {
			assert.equal(getKernelVersion(folderWith({ Makefile: 'VERSION = 6\n' })), undefined);
			const empty = 'VERSION =\nPATCHLEVEL = 12\n';
			assert.equal(getKernelVersion(folderWith({ Makefile: empty })), undefined);
		});

		it('does not take EXTRAVERSION for VERSION', () => {
			const makefile = 'EXTRAVERSION = -rc5\nPATCHLEVEL = 12\n';
			assert.equal(getKernelVersion(folderWith({ Makefile: makefile })), undefined);
		});

		it('is not looked for past the first 500 bytes', () => {
			const makefile = '#'.repeat(600) + '\n' + KERNEL_MAKEFILE;
			assert.equal(getKernelVersion(folderWith({ Makefile: makefile })), undefined);
		});

		it('is undefined when Makefile is a directory or the folder does not exist', () => {
			const dir = folderWith({});
			fs.mkdirSync(path.join(dir, 'Makefile'));
			assert.equal(getKernelVersion(dir), undefined);
			const missing = path.join(os.tmpdir(), 'kwb-test-does-not-exist');
			assert.equal(getKernelVersion(missing), undefined);
		});
	});

	describe('the Linux root commit', () => {
		it('is asked of git, in dir, by type', () => {
			git = fakeGit('commit');
			isLinuxKernelRepo('/src/linux');
			assert.deepEqual(git.calls, [
				{ command: `git cat-file -t ${LINUX_ROOT_COMMIT}`, cwd: '/src/linux' },
			]);
		});

		it('makes a repository that contains it a Linux repo', () => {
			git = fakeGit('commit');
			assert.equal(isLinuxKernelRepo('/src/linux'), true);
		});

		it('must be a commit, not another kind of object', () => {
			git = fakeGit('blob');
			assert.equal(isLinuxKernelRepo('/src/linux'), false);
		});

		it('is missing where git fails: no repository, no such folder, no git', () => {
			git = fakeGit(undefined);
			assert.equal(isLinuxKernelRepo('/src/linux'), false);
		});
	});

	describe('a kernel tree', () => {
		it('is a Linux repo with a kernel Makefile', () => {
			git = fakeGit('commit');
			assert.equal(isKernelTree(kernelTree()), true);
		});

		it('is not a kernel Makefile outside a Linux repo, e.g. a kernel.org tarball', () => {
			git = fakeGit(undefined);
			assert.equal(isKernelTree(kernelTree()), false);
		});

		it('is not a Linux repo without a kernel Makefile', () => {
			git = fakeGit('commit');
			assert.equal(isKernelTree(folderWith({ Makefile: 'all:\n' })), false);
			// VS Code activates the extension on Kbuild alone (workspaceContains:Kbuild),
			// so this check is what keeps such folders from being treated as kernel trees.
			assert.equal(isKernelTree(folderWith({ Kbuild: '', Kconfig: '' })), false);
		});

		it('is not a folder that does not exist', () => {
			git = fakeGit(undefined);
			assert.equal(isKernelTree(path.join(os.tmpdir(), 'kwb-test-does-not-exist')), false);
		});
	});
});
