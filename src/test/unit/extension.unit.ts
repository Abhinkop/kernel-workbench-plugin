// activate(): nothing outside a kernel tree; in one, exactly the commands
// package.json contributes, and the kernelWorkbench.active context key.
// And the manifest: everything it refers to exists.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { answer, extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { fakeGit, kernelTree, tempDir } from '../helpers/repo';
import { activate } from '../../extension';

const root = path.join(__dirname, '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributes = pkg.contributes ?? {};

describe('activate', () => {
	let git: ReturnType<typeof fakeGit>;
	beforeEach(() => (git = fakeGit('commit')));
	afterEach(() => git.restore());

	const setContext = (key: string) =>
		state.executed.find(e => e.id === 'setContext' && e.args[0] === key)?.args[1];

	it('does nothing outside a kernel tree', () => {
		vscode.workspace.workspaceFolders = [workspaceFolder(tempDir())];
		assert.equal(activate(extensionContext()), undefined);
		assert.equal(state.commands.size, 0);
		assert.equal(setContext('kernelWorkbench.active'), undefined);
	});

	it('registers exactly the commands the manifest contributes', () => {
		vscode.workspace.workspaceFolders = [workspaceFolder(kernelTree())];
		const api = activate(extensionContext());
		assert.ok(api?.settings && api.kernelView);
		const contributed = ((contributes.commands ?? []) as { command: string }[])
			.map(c => c.command)
			.sort();
		assert.ok(contributed.length > 0);
		assert.deepEqual([...state.commands.keys()].sort(), contributed);
		assert.equal(setContext('kernelWorkbench.active'), true);
	});

	it('reports missing tools once, offers to install them, and can be silenced', async () => {
		vscode.workspace.workspaceFolders = [workspaceFolder(kernelTree())];
		state.config['kernelWorkbench.crossCompile'] = {
			x86_64: 'no-such-',
			arm64: 'no-such-',
			riscv64: 'no-such-',
		};
		const api = activate(extensionContext());
		assert.ok(api);
		await new Promise(resolve => setTimeout(resolve, 50));
		const first = state.log.find(l => l.kind === 'warning');
		assert.ok(first, 'a warning');
		assert.match(String(first.message), /missing tools for .*no-such-gcc/);
		assert.ok(first.items.includes("Don't Show Again"));

		answer('Run Install Command');
		await api.checkTools(true);
		const install = state.terminals.find(t => t.name === 'Install kernel tools');
		if (install) {
			assert.match(install.sent[0], /apt-get install .*gcc/);
		}

		answer("Don't Show Again");
		await api.checkTools(false); // the same set again: no new warning
		state.log = [];
		await api.checkTools(false);
		assert.equal(state.log.filter(l => l.kind === 'warning').length, 0, 'silenced');
	});
});

describe('the manifest', () => {
	const commands = new Set((contributes.commands ?? []).map((c: any) => c.command));
	const submenus = new Set((contributes.submenus ?? []).map((s: any) => s.id));
	const views: any[] = Object.values(contributes.views ?? {}).flat();

	it('refers only to real commands and submenus from its menus and keybindings', () => {
		for (const [menu, items] of Object.entries(contributes.menus ?? {})) {
			for (const item of items as any[]) {
				const target = item.command ?? item.submenu;
				assert.ok(
					item.command ? commands.has(item.command) : submenus.has(item.submenu),
					`${menu}: ${target}`,
				);
			}
		}
		for (const binding of contributes.keybindings ?? []) {
			assert.ok(
				commands.has(binding.command),
				`keybinding ${binding.key}: ${binding.command}`,
			);
		}
	});

	it('puts every view in a real container, with an icon file that exists', () => {
		const containers = new Set(
			(contributes.viewsContainers?.activitybar ?? []).map((c: any) => c.id),
		);
		for (const [container, list] of Object.entries(contributes.views ?? {})) {
			assert.ok(containers.has(container), container);
			for (const view of list as any[]) {
				assert.ok(
					view.icon && fs.existsSync(path.join(root, view.icon)),
					`${view.id} icon`,
				);
			}
		}
		for (const container of contributes.viewsContainers?.activitybar ?? []) {
			assert.ok(fs.existsSync(path.join(root, container.icon)), `${container.id} icon`);
		}
		for (const welcome of contributes.viewsWelcome ?? []) {
			assert.ok(
				views.some(v => v.id === welcome.view),
				welcome.view,
			);
		}
	});

	describe('menus', () => {
		const menus = contributes.menus ?? {};
		const STEPS = ['kernelWorkbench.configure', 'kernelWorkbench.build'];

		it('puts the steps as buttons on the toolbar of every kernel editor', () => {
			for (const command of STEPS) {
				const item = (menus['editor/title'] ?? []).find((m: any) => m.command === command);
				assert.ok(item, `${command} on the editor toolbar`);
				assert.match(
					item.group,
					/^navigation/,
					`${command} is a button, not in the … menu`,
				);
				assert.match(item.when, /^kernelWorkbench\.active/, `${command} on every editor`);
				const declared = contributes.commands.find((c: any) => c.command === command);
				assert.ok(declared?.icon, `${command} has an icon`);
			}
		});

		it('puts the steps on the Kernel view toolbar and in the Kernel Workbench menu', () => {
			for (const command of STEPS) {
				const onView = (menus['view/title'] ?? []).some(
					(m: any) =>
						m.command === command &&
						/view == kernelWorkbench\.kernel/.test(m.when) &&
						/^navigation/.test(m.group),
				);
				assert.ok(onView, `${command} on the view toolbar`);
				const inMenu = (menus['kernelWorkbench.target'] ?? []).some(
					(m: any) => m.command === command,
				);
				assert.ok(inMenu, `${command} in the Kernel Workbench menu`);
			}
		});

		it('puts the Kernel Workbench menu on the toolbar of every kernel editor', () => {
			const item = (menus['editor/title'] ?? []).find(
				(m: any) => m.submenu === 'kernelWorkbench.target',
			);
			assert.ok(item, 'the submenu on the editor toolbar');
			assert.match(item.group, /^navigation/, 'a toolbar button, not in the … menu');
			assert.match(item.when, /^kernelWorkbench\.active/, 'on every editor of the tree');
			const submenu = (contributes.submenus ?? []).find(
				(s: any) => s.id === 'kernelWorkbench.target',
			);
			assert.equal(submenu?.label, 'Kernel Workbench');
			assert.ok(submenu?.icon, 'has an icon');
		});

		it('offers the steps first, then the three Select commands', () => {
			const entries = menus['kernelWorkbench.target'] ?? [];
			const commands = entries.map((m: any) => m.command);
			assert.deepEqual(
				commands.filter((c: string) => /\.select/.test(c)),
				[
					'kernelWorkbench.selectArch',
					'kernelWorkbench.selectVariant',
					'kernelWorkbench.selectConfig',
				],
			);
			const groups = entries.map((m: any) => m.group);
			assert.deepEqual([...groups].sort(), groups, 'in group order: steps, then the target');
			assert.match(groups[0], /^0_steps/);
		});
	});

	it('ties every row action to its kind of row', () => {
		// A command on a row's menu is about that row, never on every row of a view.
		for (const item of contributes.menus?.['view/item/context'] ?? []) {
			assert.match(item.when, /viewItem ==/, `${item.command} would show on every row`);
		}
	});

	it('gives every setting a default, a description and resource scope', () => {
		const sections = contributes.configuration ?? [];
		for (const section of Array.isArray(sections) ? sections : [sections]) {
			for (const [key, schema] of Object.entries(section.properties ?? {}) as [
				string,
				any,
			][]) {
				assert.ok('default' in schema, `${key} default`);
				assert.ok(schema.description || schema.markdownDescription, `${key} description`);
				assert.equal(schema.scope, 'resource', `${key} scope`);
			}
		}
	});

	it('has no emoji in command titles', () => {
		for (const command of contributes.commands ?? []) {
			assert.doesNotMatch(
				command.title,
				/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
				command.title,
			);
		}
	});
});
