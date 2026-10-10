// The Kernel view: the Target group's rows, the values they show, and
// "Change…", which opens the row's picker.
import * as assert from 'node:assert/strict';
import { answer, extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { fakeGit, kernelTree } from '../helpers/repo';
import { isNative } from '../../arch';
import { activate } from '../../extension';
import type { Item, KernelView } from '../../kernelView';

describe('the Kernel view', () => {
	let git: ReturnType<typeof fakeGit>;
	beforeEach(() => (git = fakeGit('commit')));
	afterEach(() => git.restore());

	/** The rows under `item` (top level when omitted), as "label — description". */
	const labels = (view: KernelView, item?: Item) =>
		view.getChildren(item).map(i => `${i.label}${i.description ? ` — ${i.description}` : ''}`);

	/** The Architecture row's description for `arch`. */
	const archRow = (arch: string) => `Architecture — ${arch}${isNative(arch) ? '' : ' (cross)'}`;

	/** Activates in a kernel tree and returns the extension's parts. */
	function open() {
		vscode.workspace.workspaceFolders = [workspaceFolder(kernelTree())];
		const api = activate(extensionContext());
		assert.ok(api, 'activated');
		return api;
	}

	it('is registered as kernelWorkbench.kernel', () => {
		const { kernelView } = open();
		assert.equal(state.providers['tree:kernelWorkbench.kernel']?.provider, kernelView);
	});

	it('shows the target: architecture, Debug or Release, and base config', () => {
		const { kernelView, settings } = open();
		assert.deepEqual(labels(kernelView), ['Target']);
		const [target] = kernelView.getChildren();
		assert.deepEqual(labels(kernelView, target), [
			archRow(settings.arch),
			'Build — Debug',
			'Base config — defconfig',
		]);
	});

	it('shows the picked values, and re-renders when they change', async () => {
		const { kernelView, settings } = open();
		let changed = 0;
		kernelView.onDidChangeTreeData(() => changed++);
		await settings.select('arch', 'riscv64');
		await settings.select('variant', 'release');
		await settings.select('config', '/home/me/my.config');
		assert.equal(changed, 3);
		const [target] = kernelView.getChildren();
		assert.deepEqual(labels(kernelView, target), [
			archRow('riscv64'),
			'Build — Release',
			'Base config — my.config',
		]);
		const config = kernelView.getChildren(target)[2];
		assert.equal(config.tooltip, '/home/me/my.config', 'the full path, in the tooltip');
	});

	it('opens a row’s picker on a click, through kernelWorkbench.editItem', async () => {
		const { kernelView, settings } = open();
		const [target] = kernelView.getChildren();
		const [arch, variant, config] = kernelView.getChildren(target);
		for (const row of [arch, variant, config]) {
			assert.equal(row.contextValue, 'edit', `${row.label} offers Change…`);
			assert.equal(row.command?.command, 'kernelWorkbench.editItem');
			assert.equal(row.command?.arguments?.[0], row, 'a click passes the row');
		}

		answer((items: any[]) => items.find(i => i.label === 'arm64'));
		await vscode.commands.executeCommand('kernelWorkbench.editItem', arch);
		assert.equal(settings.arch, 'arm64');
		answer((items: any[]) => items.find(i => i.label === 'Release'));
		await vscode.commands.executeCommand('kernelWorkbench.editItem', variant);
		assert.equal(settings.variant, 'release');
		answer((items: any[]) => items.find(i => i.label === 'tinyconfig'));
		await vscode.commands.executeCommand('kernelWorkbench.editItem', config);
		assert.equal(settings.config, 'tinyconfig');

		// The group row has no option, and the inline action may pass nothing.
		await vscode.commands.executeCommand('kernelWorkbench.editItem', target);
		await vscode.commands.executeCommand('kernelWorkbench.editItem');
		assert.equal(state.log.length, 3, 'only the three pickers were shown');
	});
});
