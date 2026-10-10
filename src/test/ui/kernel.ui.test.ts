// What a user sees and clicks, in a real VS Code window driven by vscode-extension-tester:
// the Kernel tab's Target rows, their right-click menu and pickers, and the editor toolbar.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	ActivityBar,
	By,
	EditorView,
	InputBox,
	Key,
	TextEditor,
	VSBrowser,
	WebDriver,
	WebElement,
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

/**
 * The entries of the open context menu, read from the DOM: the menu fades in, and when the
 * test window is not in front the fade may never finish, so Selenium does not count it as
 * displayed. Since VS Code 1.133 some menus (the text editor's) render in a shadow root on a
 * .shadow-root-host; the others in the document's .context-view.
 */
async function contextMenuLabels(driver: WebDriver): Promise<string[] | undefined> {
	const read = async (scope: { findElements(by: By): Promise<WebElement[]> }) => {
		const entries = await scope.findElements(By.css('.monaco-menu .action-label'));
		const texts = await Promise.all(entries.map(e => e.getAttribute('textContent')));
		return texts.map(t => (t ?? '').trim());
	};
	for (const host of await driver.findElements(By.css('.shadow-root-host'))) {
		const labels = await read(await host.getShadowRoot()).catch(() => []);
		if (labels.length) {
			return labels;
		}
	}
	for (const view of await driver.findElements(By.css('.context-view'))) {
		const labels = await read(view);
		if (labels.length) {
			return labels;
		}
	}
	return undefined;
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
		// The Steps row named Build comes before the Target row of that name.
		assert.match(await description('Build'), /^\w+ (Debug|Release) \(not configured yet\)$/);
		assert.ok((await description('Base config')).length > 0, 'a base config');
		assert.strictEqual(await description('Configured'), 'not yet');
		assert.match(await description('Tools'), /^(all installed|missing \d+)$/);
	});

	it('right-clicking a target row offers only "Change…"', async () => {
		const item = await row('Architecture');
		const driver = item.getDriver();
		await driver.actions().contextClick(item).perform();
		const labels = await until(() => contextMenuLabels(driver), 10000, 'the context menu');
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
		assert.match(await description('Build'), /^\w+ (Debug|Release)$/, 'Build no longer warns');
	});

	it('offers the other actions under More', async () => {
		const more = await row('More');
		if (!(await more.isExpanded())) {
			await more.expand();
		}
		for (const label of [
			'menuconfig',
			'nconfig',
			'Clean',
			'Rebuild',
			'Full clean',
			'Check tools',
		]) {
			assert.ok(await row(label), label);
		}
		assert.strictEqual(await description('Clean'), 'make clean');
		await more.collapse();
	});

	it('points clangd at the selected build from the command palette', async () => {
		// A database as the build would leave it; the command publishes it at the root.
		const build = path.join(tree(), 'build', 'x86_64', 'debug');
		fs.mkdirSync(build, { recursive: true });
		const db = [{ directory: build, file: 'init/main.c', command: 'gcc -c init/main.c' }];
		fs.writeFileSync(path.join(build, 'compile_commands.json'), JSON.stringify(db));
		await new Workbench().executeCommand('Kernel: Point clangd at the Selected Build');
		const published = path.join(tree(), 'compile_commands.json');
		await until(() => fs.existsSync(published), 10000, 'compile_commands.json at the root');
		assert.match(fs.readFileSync(published, 'utf8'), /--target=x86_64-linux-gnu/);
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

		it('has the Kernel Workbench menu, Configure and Build on the toolbar', async () => {
			const titles = await until(
				async () => {
					const actions = await new EditorView().getActions();
					const all = await Promise.all(actions.map(action => action.getTitle()));
					return all.length > 0 ? all : undefined;
				},
				10000,
				'the editor toolbar',
			);
			for (const title of ['Kernel Workbench', 'Configure', 'Build']) {
				assert.ok(
					titles.some(t => t === title || t.startsWith(`${title} (`)),
					`"${title}" in ${titles.join(' | ')}`,
				);
			}
		});

		it('right-click offers the Kernel Workbench menu, not the steps', async () => {
			const editor = new TextEditor();
			const driver = editor.getDriver();
			await driver.actions().contextClick(editor).perform();
			const labels = await until(
				() => contextMenuLabels(driver),
				10000,
				'the editor context menu',
			);
			await driver.actions().sendKeys(Key.ESCAPE).perform();
			assert.ok(labels.includes('Kernel Workbench'), labels.join(', '));
			assert.ok(
				!labels.includes('Build') && !labels.includes('Configure'),
				labels.join(', '),
			);
			// The submenu's own entries are checked against the manifest in the unit tests.
		});

		after(async () => {
			await new EditorView().closeAllEditors();
		});
	});
});
