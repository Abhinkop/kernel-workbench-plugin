// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): the tool check, and what the Kernel tab and the warning say when a
// compiler is missing.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { answer, api, child, labels, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('The tool check in VS Code', function () {
	this.timeout(60 * 1000);
	let x: KernelWorkbench;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);

	/** The Tools row and the tools it lists. */
	const tools = async () => {
		const status = await child(x.kernelView, 'Status');
		const row = await child(x.kernelView, 'Tools', status);
		assert.ok(row, 'the Tools row');
		const [label] = await labels(x.kernelView, status).then(l =>
			l.filter(r => /^Tools/.test(r)),
		);
		return { label, list: await labels(x.kernelView, row) };
	};

	before(async () => {
		x = await api();
		await x.settings.select('arch', 'x86_64');
	});

	it('checks the host tools and shows the result in the Kernel tab', async () => {
		// The check waits for its notification to be dismissed.
		const info = answer('showInformationMessage', [undefined]);
		const warning = answer('showWarningMessage', [undefined]);
		try {
			await x.checkTools(true);
		} finally {
			info.restore();
			warning.restore();
		}
		assert.strictEqual(info.asked.length + warning.asked.length, 1, 'one notification');
		assert.match((await tools()).label, /^Tools — (all installed|missing \d+)$/);
	});

	it('lists a missing compiler, with the command to install it', async () => {
		const warning = answer('showWarningMessage', [undefined, undefined, undefined]);
		try {
			await cfg().update(
				'crossCompile',
				{ x86_64: 'no-such-' },
				vscode.ConfigurationTarget.Workspace,
			);
			await x.checkTools(true);
			const { label, list } = await tools();
			assert.match(label, /^Tools — missing \d+$/);
			assert.ok(list.includes('no-such-gcc (gcc-no-such)'), list.join(', '));
			const asked = warning.asked.map(a => String(a[0]));
			assert.ok(
				asked.some(m => /missing tools for x86_64 .*no-such-gcc/.test(m)),
				asked.join(' | '),
			);
			assert.ok(
				asked.some(m => /apt-get install .*gcc-no-such/.test(m)),
				asked.join(' | '),
			);
		} finally {
			await cfg().update('crossCompile', undefined, vscode.ConfigurationTarget.Workspace);
			await until(
				() => !/no-such-gcc/.test(JSON.stringify(x.settings.makeArgsForConfigure())),
				5000,
			);
			await x.checkTools(true).catch(() => undefined);
			warning.restore();
		}
	});
});
