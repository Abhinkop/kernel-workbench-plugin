// What a user sees and clicks, in a real VS Code window driven by vscode-extension-tester:
// the Kernel tab's Target rows, their right-click menu and pickers, and the editor toolbar.
import * as assert from 'assert';
import * as path from 'path';
import {
	ActivityBar,
	By,
	EditorView,
	InputBox,
	Key,
	VSBrowser,
	Workbench,
} from 'vscode-extension-tester';
import type { CustomTreeSection } from 'vscode-extension-tester';

const tree = () => process.env.KERNEL_TREE ?? '';

/** Poll until fn() returns something truthy. */
async function until<T>(
	fn: () => Promise<T> | T,
	timeout = 30000,
	what = 'condition',
): Promise<NonNullable<T>> {
	const start = Date.now();
	for (;;) {
		try {
			const result = await fn();
			if (result) {
				return result;
			}
		} catch {
			// not there yet
		}
		if (Date.now() - start > timeout) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}

describe('Kernel Workbench, clicked through', function () {
	this.timeout(10 * 60 * 1000);
	let kernel: CustomTreeSection;

	before(async () => {
		await VSBrowser.instance.waitForWorkbench();
		const control = await until(
			() => new ActivityBar().getViewControl('Kernel'),
			60000,
			'the Kernel icon in the activity bar',
		);
		const view = await control.openView();
		kernel = await until(
			async () => (await view.getContent().getSection('Kernel')) as CustomTreeSection,
			30000,
			'the Kernel view',
		);
	});

	const row = (label: string) => until(() => kernel.findItem(label, 3), 20000, `row "${label}"`);
	const description = async (label: string) => (await row(label)).getDescription();
	/** Open terminals, by name, from VS Code's terminal switcher (quick open "term "). */
	const terminals = async () => {
		const input = await new Workbench().openCommandPrompt();
		await input.setText('term ');
		await new Promise(resolve => setTimeout(resolve, 500));
		const names = await Promise.all((await input.getQuickPicks()).map(p => p.getLabel()));
		await input.cancel();
		return names.filter(n => !/^Create New Terminal|^No matching/.test(n));
	};

	it('shows the steps, the target and the status as rows with their values', async () => {
		for (const label of [
			'Steps',
			'Configure',
			'Target',
			'Architecture',
			'Build',
			'Base config',
		]) {
			assert.ok(await row(label), label);
		}
		assert.match(await description('Configure'), /^\w+ (Debug|Release) from \S+$/);
		assert.match(await description('Architecture'), /^(x86_64|arm64|riscv64)/);
		assert.match(await description('Build'), /^(Debug|Release)$/);
		assert.ok((await description('Base config')).length > 0, 'a base config');
		assert.strictEqual(await description('Configured'), 'not yet');
	});

	it('right-clicking a target row offers only "Change…"', async () => {
		const item = await row('Architecture');
		const driver = item.getDriver();
		await driver.actions().contextClick(item).perform();
		// The menu's entries, from the DOM: the menu fades in, and when the test window is
		// not in front the fade may never finish, so Selenium does not count it as displayed.
		const labels = await until(
			async () => {
				const entries = await driver.findElements(
					By.css('.context-view .monaco-menu .action-label'),
				);
				const texts = await Promise.all(entries.map(e => e.getAttribute('textContent')));
				return texts.length ? texts.map(t => (t ?? '').trim()) : undefined;
			},
			10000,
			'the context menu',
		);
		await driver.actions().sendKeys(Key.ESCAPE).perform();
		assert.deepStrictEqual(labels, ['Change…']);
	});

	it('clicking Architecture opens the architecture picker', async () => {
		await (await row('Architecture')).click();
		const input = await InputBox.create();
		const picks = await Promise.all((await input.getQuickPicks()).map(pick => pick.getLabel()));
		await input.cancel();
		for (const arch of ['x86_64', 'arm64', 'riscv64']) {
			assert.ok(
				picks.some(pick => pick.startsWith(arch)),
				`${arch} in ${picks.join(', ')}`,
			);
		}
	});

	it('clicking Configure configures, and its terminal closes when it succeeds', async () => {
		await (await row('Configure')).click();
		await until(
			async () => (await description('Configured')) !== 'not yet',
			180000,
			'Configure to finish',
		);
		// The Configure terminal opened, and closed when it succeeded.
		await until(
			async () => !(await terminals()).some(n => /Configure/.test(n)),
			15000,
			'the Configure terminal to close',
		);
	});

	describe('editor', () => {
		before(async () => {
			await VSBrowser.instance.openResources(path.join(tree(), 'kernel/sched/core.c'));
			await until(
				async () => (await new EditorView().getOpenEditorTitles()).includes('core.c'),
				30000,
				'core.c to open',
			);
		});

		it('has the Kernel Workbench menu on the toolbar', async () => {
			const titles = await until(
				async () => {
					const actions = await new EditorView().getActions();
					const all = await Promise.all(actions.map(action => action.getTitle()));
					return all.length > 0 ? all : undefined;
				},
				10000,
				'the editor toolbar',
			);
			assert.ok(
				titles.some(title => title.startsWith('Kernel Workbench')),
				`"Kernel Workbench" in ${titles.join(' | ')}`,
			);
		});

		after(async () => {
			await new EditorView().closeAllEditors();
		});
	});
});
