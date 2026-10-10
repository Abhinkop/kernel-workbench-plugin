// Click-through UI tests: vscode-extension-tester drives a real VS Code window with WebDriver
// (clicks, right-clicks, toolbars, quick picks) on a throwaway clone of the kernel tree in
// KERNEL_TREE, with the packaged extension installed. Run them with the "npm: test:ui" task,
// which passes the kernelWorkbench.dev.kernelTree setting in KERNEL_TREE; CI sets KERNEL_TREE
// to its own clone.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ExTester, ReleaseQuality } from 'vscode-extension-tester';

const extension = path.resolve(__dirname, '../../..');

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main(): Promise<number> {
	const source = process.env.KERNEL_TREE;
	if (!source) {
		throw new Error(
			'KERNEL_TREE is not set. Set kernelWorkbench.dev.kernelTree in .vscode/settings.json ' +
				'and run the "npm: test:ui" task.',
		);
	}
	// Set in processes spawned by VS Code's extension host; it would make the VS Code under
	// test run as plain Node and exit on its first Chromium flag. @vscode/test-cli drops
	// it too.
	delete process.env.ELECTRON_RUN_AS_NODE;
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-ui-'));
	try {
		// --shared: the clone borrows the source tree's objects, so it is quick and the
		// source tree is never written to.
		const tree = path.join(work, 'linux');
		git(work, 'clone', '-q', '--shared', source, tree);
		const settings = path.join(work, 'settings.json');
		fs.writeFileSync(
			settings,
			JSON.stringify({
				'security.workspace.trust.enabled': false,
				'workbench.startupEditor': 'none',
				'workbench.view.alwaysShowHeaderActions': true,
				'window.dialogStyle': 'custom',
				'extensions.autoCheckUpdates': false,
				'update.mode': 'none',
			}),
		);
		process.env.KERNEL_TREE = tree;

		// Downloads (VS Code, ChromeDriver) are kept between runs.
		const storage = path.join(extension, '.vscode-test', 'extest');
		const tester = new ExTester(storage, ReleaseQuality.Stable, path.join(work, 'extensions'));
		return await tester.setupAndRunTests(
			path.join(__dirname, '*.ui.test.js'),
			'latest',
			{ installDependencies: false },
			{ resources: [tree], settings, cleanup: true },
		);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

main().then(
	code => process.exit(code),
	error => {
		console.error(error.stack ?? error);
		process.exit(1);
	},
);
