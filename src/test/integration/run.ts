// Runs the tests that need a real VS Code with a kernel tree open (the "integration" label
// of .vscode-test.mjs) on a throwaway clone of the kernel tree in KERNEL_TREE, so that
// steps such as Configure can write into it. Run it with the "npm: test:integration" task,
// which passes the kernelWorkbench.dev.kernelTree setting in KERNEL_TREE; CI sets
// KERNEL_TREE to its own clone.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const extension = path.resolve(__dirname, '../../..');

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main(): number {
	const source = process.env.KERNEL_TREE;
	if (!source) {
		throw new Error(
			'KERNEL_TREE is not set. Set kernelWorkbench.dev.kernelTree in .vscode/settings.json ' +
				'and run the "npm: test:integration" task.',
		);
	}
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-it-'));
	try {
		// --shared: the clone borrows the source tree's objects, so it is quick and the
		// source tree is never written to.
		const tree = path.join(work, 'linux');
		git(work, 'clone', '-q', '--shared', source, tree);
		git(tree, 'config', 'user.name', 'Kernel Workbench Test');
		git(tree, 'config', 'user.email', 'test@example.com');
		git(tree, 'checkout', '-q', '-B', 'kwb-test-base', 'HEAD');
		const result = spawnSync(
			path.join(extension, 'node_modules', '.bin', 'vscode-test'),
			['--label', 'integration'],
			{ cwd: extension, env: { ...process.env, KERNEL_TREE: tree }, stdio: 'inherit' },
		);
		return result.status ?? 1;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

process.exit(main());
