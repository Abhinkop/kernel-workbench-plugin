// compile_commands.json for clangd: published at the root of the tree after a build, gcc-only
// flags stripped, and following the selected architecture and variant.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { answer, extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { fakeGit, kernelTree, tempDir } from '../helpers/repo';
import { updateCompileCommands } from '../../clangd';
import { activate } from '../../extension';

describe('clangd', () => {
	/** A configured state over `build`, whose compile_commands.json is `db`. */
	function configured(build: string, arch: string, makeArgs: string[], db: unknown[]) {
		fs.writeFileSync(path.join(build, 'compile_commands.json'), JSON.stringify(db));
		return {
			arch,
			variant: 'debug' as const,
			config: 'defconfig',
			buildDir: build,
			makeArgs,
			configuredAt: 'now',
		};
	}

	it('publishes compile_commands.json, stripping gcc-only flags for GCC builds', async () => {
		const root = tempDir();
		const build = tempDir();
		const db = [
			{
				directory: build,
				file: 'a.c',
				command:
					'gcc -O2 -mrecord-mcount -fconserve-stack -Werror -Werror=implicit-int -c a.c',
			},
			{ directory: build, file: 'b.c', arguments: ['gcc', '-mskip-rax-setup', '-c', 'b.c'] },
		];
		await updateCompileCommands(root, configured(build, 'x86_64', ['CROSS_COMPILE='], db));
		const out = JSON.parse(fs.readFileSync(path.join(root, 'compile_commands.json'), 'utf8'));
		assert.equal(
			out[0].command,
			'gcc -O2 -Werror=implicit-int -c a.c ' +
				'-Wno-unknown-warning-option --target=x86_64-linux-gnu',
		);
		assert.deepEqual(out[1].arguments, [
			'gcc',
			'-c',
			'b.c',
			'-Wno-unknown-warning-option',
			'--target=x86_64-linux-gnu',
		]);
	});

	it('copies LLVM databases unchanged, and can be turned off', async () => {
		const root = tempDir();
		const build = tempDir();
		const db = [{ directory: build, file: 'a.c', command: 'clang -Werror -c a.c' }];
		await updateCompileCommands(root, configured(build, 'arm64', ['LLVM=1'], db));
		const out = path.join(root, 'compile_commands.json');
		assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), db);
		fs.rmSync(out);
		state.config['kernelWorkbench.clangd.updateCompileCommands'] = false;
		await updateCompileCommands(root, configured(build, 'arm64', ['LLVM=1'], db));
		assert.ok(!fs.existsSync(out));
	});

	it('restarts clangd when its extension is installed', async () => {
		const root = tempDir();
		const build = tempDir();
		await updateCompileCommands(root, configured(build, 'x86_64', ['CROSS_COMPILE='], []));
		assert.ok(!state.executed.some(e => e.id === 'clangd.restart'), 'no extension: no restart');
		state.extensions['llvm-vs-code-extensions.vscode-clangd'] = {};
		await updateCompileCommands(root, configured(build, 'x86_64', ['CROSS_COMPILE='], []));
		assert.ok(state.executed.some(e => e.id === 'clangd.restart'));
	});

	it('follows the architecture picked, when that build exists', async () => {
		const git = fakeGit('commit');
		try {
			const root = kernelTree();
			vscode.workspace.workspaceFolders = [workspaceFolder(root)];
			const api = activate(extensionContext());
			assert.ok(api);
			const build = api.settings.buildDir('arm64', 'debug');
			fs.mkdirSync(build, { recursive: true });
			api.settings.saveConfigured(configured(build, 'arm64', ['LLVM=1'], [{ file: 'a.c' }]));
			answer((items: any[]) => items.find(i => i.label === 'arm64'));
			await vscode.commands.executeCommand('kernelWorkbench.selectArch');
			assert.equal(api.settings.arch, 'arm64');
			const out = path.join(root, 'compile_commands.json');
			assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), [{ file: 'a.c' }]);
		} finally {
			git.restore();
		}
	});
});
