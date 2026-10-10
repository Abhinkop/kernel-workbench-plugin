// The Options group: what each option shows, how each kind is edited, and the quoting of
// arguments.
import * as assert from 'node:assert/strict';
import { answer, extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { fakeGit, kernelTree, tempDir } from '../helpers/repo';
import { activate } from '../../extension';
import { describeOption, editOption, joinArgs, OPTIONS, splitArgs } from '../../options';
import { Settings } from '../../settings';

describe('options', () => {
	const settings = () => new Settings(extensionContext(), workspaceFolder(tempDir()));
	const option = (key: string) => {
		const found = OPTIONS.find(o => o.key === key);
		assert.ok(found, key);
		return found;
	};

	it('describes each option from its setting', () => {
		const s = settings();
		assert.equal(describeOption(s, option('toolchain')), 'GCC');
		assert.equal(describeOption(s, option('make.ccache')), 'off');
		assert.equal(describeOption(s, option('make.args')), 'none');
		assert.equal(
			describeOption(s, option('terminal.afterTask')),
			'Close the terminal if it succeeded',
		);
		assert.equal(describeOption(s, option('run.smp')), '2');
		assert.match(describeOption(s, option('crossCompile')), /^default \(\w+: /);
		assert.match(describeOption(s, option('run.initramfs')), /^none \(\w+\)$/);
		state.config['kernelWorkbench.make.args'] = ['W=1', 'CC=ccache gcc'];
		state.config['kernelWorkbench.configure.options'] = { KASAN: 'y' };
		state.config['kernelWorkbench.run.initramfs'] = { [s.arch]: '/srv/i.cpio' };
		assert.equal(describeOption(s, option('make.args')), 'W=1 "CC=ccache gcc"');
		assert.equal(describeOption(s, option('configure.options')), 'KASAN=y');
		assert.equal(describeOption(s, option('run.initramfs')), `i.cpio (${s.arch})`);
	});

	it('edits each kind of option', async () => {
		const s = settings();
		answer((items: any[]) => items.find(i => i.value === 'llvm'));
		await editOption(s, option('toolchain'));
		assert.equal(state.config['kernelWorkbench.toolchain'], 'llvm');
		await editOption(s, option('make.ccache'));
		assert.equal(state.config['kernelWorkbench.make.ccache'], true);
		answer('W=1 "KCFLAGS=-Og -g"');
		await editOption(s, option('make.args'));
		assert.deepEqual(state.config['kernelWorkbench.make.args'], ['W=1', 'KCFLAGS=-Og -g']);
		answer('CONFIG_KASAN=y LOCALVERSION="-x"');
		await editOption(s, option('configure.options'));
		assert.deepEqual(state.config['kernelWorkbench.configure.options'], {
			KASAN: 'y',
			LOCALVERSION: '-x',
		});
		answer('4');
		await editOption(s, option('run.smp'));
		assert.equal(state.config['kernelWorkbench.run.smp'], 4);
		answer('my-');
		await editOption(s, option('crossCompile'));
		assert.deepEqual(state.config['kernelWorkbench.crossCompile'], { [s.arch]: 'my-' });
		answer((items: any[]) => items[0], [vscode.Uri.file('/srv/i.cpio')]);
		await editOption(s, option('run.initramfs'));
		assert.deepEqual(state.config['kernelWorkbench.run.initramfs'], {
			[s.arch]: '/srv/i.cpio',
		});
		answer((items: any[]) => items[1]);
		await editOption(s, option('run.initramfs'));
		assert.deepEqual(state.config['kernelWorkbench.run.initramfs'], {});
		answer('kernel/configs/debug.config');
		await editOption(s, option('configure.fragments'));
		assert.deepEqual(state.config['kernelWorkbench.configure.fragments'], [
			'kernel/configs/debug.config',
		]);
		answer(undefined);
		await editOption(s, option('run.cmdline'));
		assert.equal(
			state.config['kernelWorkbench.run.cmdline'],
			undefined,
			'cancel leaves it alone',
		);
	});

	it('splits and joins arguments with quotes', () => {
		assert.deepEqual(splitArgs(`W=1 "CC=ccache gcc" 'a b' x\\"y`), [
			'W=1',
			'CC=ccache gcc',
			'a b',
			'x\\"y',
		]);
		assert.equal(joinArgs(['W=1', 'CC=ccache gcc']), 'W=1 "CC=ccache gcc"');
	});

	it('lists every option under Options in the Kernel view, edited through Change…', async () => {
		const git = fakeGit('commit');
		try {
			vscode.workspace.workspaceFolders = [workspaceFolder(kernelTree())];
			const api = activate(extensionContext());
			assert.ok(api);
			const view = api.kernelView;
			const options = view.getChildren().find(i => i.label === 'Options');
			assert.ok(options, 'the Options group');
			assert.equal(options.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
			const rows = view.getChildren(options);
			assert.deepEqual(
				rows.map(r => r.label),
				OPTIONS.map(o => o.label),
			);
			assert.ok(
				rows.every(
					r =>
						r.contextValue === 'edit' &&
						r.tooltip === `kernelWorkbench.${r.option?.key}`,
				),
			);
			const ccache = rows.find(r => r.label === 'ccache');
			await vscode.commands.executeCommand('kernelWorkbench.editItem', ccache);
			assert.equal(state.config['kernelWorkbench.make.ccache'], true);
			assert.equal(
				view
					.getChildren(view.getChildren().find(i => i.label === 'Options'))
					.find(r => r.label === 'ccache')?.description,
				'on',
			);
		} finally {
			git.restore();
		}
	});
});
