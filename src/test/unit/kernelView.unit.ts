// The Kernel view: the Steps, Target and Status groups, the values their
// rows show, "Change…" opening a target row's picker, and the running step.
import * as assert from 'node:assert/strict';
import { answer, extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { fakeGit, kernelTree } from '../helpers/repo';
import { isNative } from '../../arch';
import { activate } from '../../extension';
import type { Item, KernelView } from '../../kernelView';
import { runTask } from '../../tasks';

describe('the Kernel view', () => {
	let git: ReturnType<typeof fakeGit>;
	beforeEach(() => (git = fakeGit('commit')));
	afterEach(() => git.restore());

	/** The rows under `item` (top level when omitted), as "label — description". */
	const labels = (view: KernelView, item?: Item) =>
		view.getChildren(item).map(i => `${i.label}${i.description ? ` — ${i.description}` : ''}`);

	/** The group row with that label, freshly rendered. */
	const group = (view: KernelView, label: string) => {
		const row = view.getChildren().find(i => i.label === label);
		assert.ok(row, `the ${label} group`);
		return row;
	};

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

	it('shows the steps, the target and the status', () => {
		const { kernelView, settings } = open();
		assert.deepEqual(labels(kernelView), ['Steps', 'Target', 'Status']);
		const steps = kernelView.getChildren(group(kernelView, 'Steps'));
		assert.deepEqual(
			steps.map(r => [r.label, r.description, r.command?.command, r.contextValue]),
			[
				[
					'Configure',
					`${settings.arch} Debug from defconfig`,
					'kernelWorkbench.configure',
					'step',
				],
			],
		);
		assert.deepEqual(labels(kernelView, group(kernelView, 'Target')), [
			archRow(settings.arch),
			'Build — Debug',
			'Base config — defconfig',
		]);
		assert.deepEqual(labels(kernelView, group(kernelView, 'Status')), ['Configured — not yet']);
	});

	it('shows the picked values, and re-renders when they change', async () => {
		const { kernelView, settings } = open();
		let changed = 0;
		kernelView.onDidChangeTreeData(() => changed++);
		await settings.select('arch', 'riscv64');
		await settings.select('variant', 'release');
		await settings.select('config', '/home/me/my.config');
		assert.equal(changed, 3);
		assert.deepEqual(labels(kernelView, group(kernelView, 'Target')), [
			archRow('riscv64'),
			'Build — Release',
			'Base config — my.config',
		]);
		const [configure] = kernelView.getChildren(group(kernelView, 'Steps'));
		assert.equal(configure.description, 'riscv64 Release from my.config');
		const config = kernelView.getChildren(group(kernelView, 'Target'))[2];
		assert.equal(config.tooltip, '/home/me/my.config', 'the full path, in the tooltip');
	});

	it('shows when the target was configured', () => {
		const { kernelView, settings } = open();
		settings.saveConfigured({
			arch: settings.arch,
			variant: 'debug',
			config: 'defconfig',
			buildDir: settings.buildDir(),
			makeArgs: ['O=x'],
			configuredAt: '2026-10-10T09:00:00.000Z',
		});
		const [configured] = kernelView.getChildren(group(kernelView, 'Status'));
		assert.equal(configured.label, 'Configured');
		assert.notEqual(configured.description, 'not yet');
		assert.match(String(configured.tooltip), /^From defconfig\n/);
	});

	it('shows the step that is running, and sets kernelWorkbench.busy', async () => {
		const { kernelView, settings } = open();
		const status = () => labels(kernelView, group(kernelView, 'Status'));
		const busy = () =>
			state.executed
				.filter(e => e.id === 'setContext' && e.args[0] === 'kernelWorkbench.busy')
				.pop()?.args[1];
		const done = runTask(settings.folder, 'Configure x86_64 Debug', 'sh', ['-c', 'sleep 0.3']);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.deepEqual(status(), ['Running — Configure x86_64 Debug', 'Configured — not yet']);
		assert.equal(busy(), true);
		await done;
		assert.deepEqual(status(), ['Configured — not yet']);
		assert.equal(busy(), false);
	});

	it('opens a row’s picker on a click, through kernelWorkbench.editItem', async () => {
		const { kernelView, settings } = open();
		const target = group(kernelView, 'Target');
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
