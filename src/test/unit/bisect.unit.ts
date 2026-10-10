// git bisect from the Kernel Git tab: marking steps until the first bad commit is found,
// and git bisect run with the build-and-test wrapper.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { makeRepo, tempDir } from '../helpers/repo';
import { registerBisect } from '../../bisect';
import { Settings } from '../../settings';
import type { Configured } from '../../settings';

describe('bisect', () => {
	/** Eight commits; the sixth adds bug.txt. */
	function bisectRepo() {
		const r = makeRepo();
		const hashes: string[] = [];
		for (let i = 1; i <= 8; i++) {
			hashes.push(
				r.commit(`step ${i}`, {
					'v.txt': `${i}\n`,
					...(i === 6 ? { 'bug.txt': 'bug\n' } : {}),
				}),
			);
		}
		const context = extensionContext();
		const settings = new Settings(context, workspaceFolder(r.dir));
		settings.configured = () => undefined;
		return { r, hashes, bad: hashes[5], context, settings };
	}

	it('finds the first bad commit by marking steps', async () => {
		const { r, hashes, bad, context, settings } = bisectRepo();
		try {
			const { bisect, view } = registerBisect(context, settings);
			await bisect.start(hashes[7], hashes[0]);
			assert.ok(bisect.active && bisect.current);
			for (let i = 0; i < 10 && !bisect.result; i++) {
				const broken = fs.existsSync(path.join(r.dir, 'bug.txt'));
				await bisect.step([broken ? 'bad' : 'good']);
			}
			assert.equal(bisect.result?.hash, bad);
			assert.equal(bisect.result?.subject, 'step 6');
			assert.match(String(state.shown.pop()?.uri), new RegExp(`^kernel-git:/commit/${bad}/`));
			const items = view.getChildren();
			assert.ok(items.some(i => i.contextValue === 'result'));
			assert.ok(items.some(i => i.label === 'Steps'));
			await vscode.commands.executeCommand('kernelWorkbench.bisect.copyFixes');
			assert.match(state.clipboard, /\("step 6"\)$/);
			await bisect.reset();
			assert.ok(!bisect.active);
			assert.equal(r.git('rev-parse', 'HEAD').trim(), hashes[7]);
			await bisect.start('no-such', hashes[0]);
			assert.match(String(state.log.pop()?.message), /"no-such" is not a commit/);
		} finally {
			r.remove();
		}
	});

	it('runs git bisect run with a build-and-test wrapper', async () => {
		const { r, hashes, bad, context, settings } = bisectRepo();
		const bin = tempDir();
		const PATH = process.env.PATH;
		try {
			fs.writeFileSync(path.join(bin, 'make'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
			process.env.PATH = `${bin}:${PATH}`;
			const buildDir = tempDir();
			const configured: Configured = {
				arch: 'x86_64',
				variant: 'debug',
				config: 'defconfig',
				buildDir,
				makeArgs: [`O=${buildDir}`],
				configuredAt: new Date().toISOString(),
			};
			settings.configured = () => configured;
			const { bisect } = registerBisect(context, settings);
			const script = path.join(tempDir(), 'test.sh');
			fs.writeFileSync(
				script,
				`#!/bin/sh\n[ "$1" = "${buildDir}" ] || exit 125\n` +
					'[ -f bug.txt ] && exit 1\nexit 0\n',
				{ mode: 0o755 },
			);
			await bisect.start(hashes[7], hashes[0]);
			await bisect.run(script);
			assert.equal(bisect.message, `First bad commit: ${bad.slice(0, 12)} step 6`);
			assert.equal(state.tasks.pop()?.name, 'git bisect run');
			await bisect.reset();
		} finally {
			process.env.PATH = PATH;
			r.remove();
		}
	});
});
