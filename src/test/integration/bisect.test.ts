// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): a bisection over real commits, marked step by step until the target
// is found, then reset.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { api, labels, tree } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Bisect in VS Code', function () {
	this.timeout(10 * 60 * 1000);
	let x: KernelWorkbench;
	const git = (...args: string[]) => execFileSync('git', args, { cwd: tree(), encoding: 'utf8' });

	before(async () => {
		x = await api();
	});

	it('bisects over real commits, and resets', async () => {
		const range = git('rev-list', '--first-parent', '--max-count=9', 'HEAD').trim().split('\n');
		const good = range[range.length - 1];
		const bad = range[0];
		const target = range[4];
		const b = x.bisect.bisect;
		await b.start(bad, good);
		assert.ok(b.active && b.current, b.message);
		let steps = 0;
		try {
			while (b.active && !b.result && steps++ < 10) {
				let broken = true;
				try {
					git('merge-base', '--is-ancestor', target, 'HEAD');
				} catch {
					broken = false;
				}
				await vscode.commands.executeCommand(
					broken ? 'kernelWorkbench.bisect.bad' : 'kernelWorkbench.bisect.good',
				);
			}
			assert.ok(b.result, `not found in ${steps} steps: ${b.message}`);
			assert.strictEqual(b.result.hash, target);
			assert.match(String(vscode.window.activeTextEditor?.document.uri), /^kernel-git:/);
			const rows = await labels(x.bisect.view);
			assert.ok(
				rows.some(r => r.includes('first bad commit')),
				rows.join('\n'),
			);
		} finally {
			await vscode.commands.executeCommand('kernelWorkbench.bisect.reset');
		}
		assert.ok(!b.active);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});
});
