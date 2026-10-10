// activate(): nothing outside a kernel tree; in one, exactly the commands
// package.json contributes, and the kernelWorkbench.active context key.
// And the manifest: everything it refers to exists.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
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
});

describe('the manifest', () => {
	const commands = new Set((contributes.commands ?? []).map((c: any) => c.command));
	const submenus = new Set((contributes.submenus ?? []).map((s: any) => s.id));
	const views: any[] = Object.values(contributes.views ?? {}).flat();

	it('refers only to real commands and submenus from its menus', () => {
		for (const [menu, items] of Object.entries(contributes.menus ?? {})) {
			for (const item of items as any[]) {
				const target = item.command ?? item.submenu;
				assert.ok(
					item.command ? commands.has(item.command) : submenus.has(item.submenu),
					`${menu}: ${target}`,
				);
			}
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
