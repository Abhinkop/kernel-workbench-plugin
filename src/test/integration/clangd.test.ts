// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): the build's compile_commands.json published at the root of the tree
// for clangd.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, tree } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('clangd in VS Code', function () {
	this.timeout(5 * 60 * 1000);
	let x: KernelWorkbench;
	const published = () => path.join(tree(), 'compile_commands.json');

	before(async () => {
		x = await api();
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		await x.settings.select('config', 'defconfig');
		if (!x.settings.configured()) {
			assert.strictEqual(
				await vscode.commands.executeCommand('kernelWorkbench.configure'),
				0,
			);
		}
	});

	it('points clangd at the selected build, stripping gcc-only flags', async () => {
		const recorded = x.settings.configured();
		assert.ok(recorded);
		const db = [
			{
				directory: recorded.buildDir,
				file: path.join(tree(), 'init/main.c'),
				command: 'gcc -O2 -mrecord-mcount -Werror -c init/main.c',
			},
		];
		fs.writeFileSync(path.join(recorded.buildDir, 'compile_commands.json'), JSON.stringify(db));
		try {
			await vscode.commands.executeCommand('kernelWorkbench.followSelection');
			const out = JSON.parse(fs.readFileSync(published(), 'utf8'));
			assert.strictEqual(
				out[0].command,
				'gcc -O2 -c init/main.c -Wno-unknown-warning-option --target=x86_64-linux-gnu',
			);
		} finally {
			fs.rmSync(published(), { force: true });
			fs.rmSync(path.join(recorded.buildDir, 'compile_commands.json'), { force: true });
		}
	});
});
