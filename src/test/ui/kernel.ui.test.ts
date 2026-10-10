// What a user sees and clicks, in a real VS Code window driven by vscode-extension-tester:
// the Kernel tab's Target rows, their right-click menu and pickers, and the editor toolbar.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	ActivityBar,
	BottomBarPanel,
	By,
	EditorView,
	InputBox,
	Key,
	MarkerType,
	SideBarView,
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

/**
 * Shows the Kernel Git container. A click on an Activity Bar item toggles its container, and
 * the sidebar switches a moment after a click, so it is clicked until the sidebar shows it.
 */
async function openKernelGit(): Promise<void> {
	const control = await until(
		() => new ActivityBar().getViewControl('Kernel Git'),
		10000,
		'the Kernel Git view control',
	);
	const shown = async () =>
		/kernel git|series/i.test(
			await new SideBarView()
				.getTitlePart()
				.getTitle()
				.catch(() => ''),
		);
	await until(
		async () => {
			if (await shown()) {
				return true;
			}
			await control.click();
			await new Promise(resolve => setTimeout(resolve, 500));
			return shown();
		},
		15000,
		'the Kernel Git container',
	);
}

/** Shows the Explorer again, waiting for the sidebar to switch, so the next test starts clean. */
async function showExplorer(): Promise<void> {
	const control = await new ActivityBar().getViewControl('Explorer');
	await until(
		async () => {
			const title = await new SideBarView()
				.getTitlePart()
				.getTitle()
				.catch(() => '');
			if (/explorer/i.test(title)) {
				return true;
			}
			await control?.click();
			await new Promise(resolve => setTimeout(resolve, 500));
			return false;
		},
		15000,
		'the Explorer',
	);
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
			'Run',
			'Debug',
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
		assert.match(await description('Run'), /^\w+ (Debug|Release) in QEMU$/);
		assert.match(await description('Debug'), /^\w+ (Debug|Release) in QEMU \+ gdb$/);
		assert.strictEqual(await description('Configured'), 'not yet');
		assert.strictEqual(await description('VM'), 'stopped');
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

	it('clicking an on/off option flips it', async () => {
		const options = await row('Options');
		if (!(await options.isExpanded())) {
			await options.expand();
		}
		const before = await description('ccache');
		await (await row('ccache')).click();
		await until(
			async () => (await description('ccache')) !== before,
			10000,
			'ccache to change',
		);
		await (await row('ccache')).click();
		await until(async () => (await description('ccache')) === before, 10000, 'ccache back');
		await options.collapse();
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

	it('lists KUnit in the Testing view', async () => {
		const control = await until(
			() => new ActivityBar().getViewControl('Testing'),
			10000,
			'the Testing view control',
		);
		await control.openView();
		const driver = VSBrowser.instance.driver;
		const rows = await until(
			async () => {
				// The test explorer's rows: a label and, for KUnit before a run, a description.
				const elements = await driver.findElements(
					By.css('.test-explorer .monaco-list-row'),
				);
				const texts = await Promise.all(elements.map(e => e.getAttribute('textContent')));
				return texts.some(t => t?.includes('KUnit ('))
					? texts.map(t => t ?? '')
					: undefined;
			},
			30000,
			'the KUnit item',
		);
		assert.ok(
			rows.some(r => r.includes('KUnit (x86_64)') && r.includes('run to discover the tests')),
			rows.join(' | '),
		);
		await (await new ActivityBar().getViewControl('Explorer'))?.openView();
	});

	it('shows the branch’s series in the Kernel Git tab', async () => {
		await openKernelGit();
		const rows = await until(
			async () => {
				const sections = await new SideBarView().getContent().getSections();
				const titles = await Promise.all(sections.map(s => s.getTitle()));
				const section = (sections[titles.indexOf('Series')] ??
					sections[0]) as CustomTreeSection;
				const items = await section.getVisibleItems();
				const texts = await Promise.all(items.map(i => i.getLabel()));
				return texts.includes('Commits') ? texts : undefined;
			},
			60000,
			'the Series view',
		);
		const expected = [
			'Actions',
			'Base',
			'Version',
			'Commits',
			'Working changes',
			'Patches',
			'Subject prefix',
		];
		for (const label of expected) {
			assert.ok(rows.includes(label), `"${label}" in ${rows.join(' | ')}`);
		}
		await showExplorer();
	});

	it('offers the dry run and the send in the command palette', async () => {
		const input = await new Workbench().openCommandPrompt();
		await input.setText('>Kernel: Send Patches');
		const picks = await until(
			async () => {
				const items = await input.getQuickPicks();
				const texts = await Promise.all(items.map(i => i.getLabel()));
				return texts.some(t => t.includes('Dry Run')) ? texts : undefined;
			},
			10000,
			'the Send Patches commands',
		);
		await input.cancel();
		assert.ok(picks.includes('Kernel: Send Patches: Dry Run'), picks.join(' | '));
		assert.ok(picks.includes('Kernel: Send Patches…'), picks.join(' | '));
	});

	it('offers to fetch or load a series in the Apply view', async () => {
		await openKernelGit();
		const welcome = await until(
			async () => {
				// Expand the view (it may be collapsed), then read the welcome contents shown in
				// the sidebar: the text and the buttons' labels.
				await (await new SideBarView().getContent().getSection('Apply')).expand();
				const views = await VSBrowser.instance.driver.findElements(
					By.css('.sidebar .welcome-view-content'),
				);
				const texts = await Promise.all(views.map(v => v.getAttribute('textContent')));
				const text = texts.join(' ').replace(/\s+/g, ' ');
				return text.includes('b4') ? text : undefined;
			},
			30000,
			'the Apply view’s welcome content',
		);
		assert.ok(welcome.includes('Fetch Series from lore…'), welcome);
		assert.ok(welcome.includes('Apply mbox or Patch Files…'), welcome);
		await showExplorer();
	});

	it('offers to start a bisect in the Bisect view', async () => {
		await openKernelGit();
		const welcome = await until(
			async () => {
				// Expand the view (it may be collapsed), then read the welcome contents shown in
				// the sidebar: the text and the buttons' labels.
				await (await new SideBarView().getContent().getSection('Bisect')).expand();
				const views = await VSBrowser.instance.driver.findElements(
					By.css('.sidebar .welcome-view-content'),
				);
				const texts = await Promise.all(views.map(v => v.getAttribute('textContent')));
				const text = texts.join(' ').replace(/\s+/g, ' ');
				return text.includes('git bisect') ? text : undefined;
			},
			30000,
			'the Bisect view’s welcome content',
		);
		assert.ok(welcome.includes('Start Bisect…'), welcome);
		assert.ok(welcome.includes('Bisect Automatically with a Test Script…'), welcome);
		await showExplorer();
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

		it('has the Kernel Workbench menu and the steps on the toolbar', async () => {
			const titles = await until(
				async () => {
					const actions = await new EditorView().getActions();
					const all = await Promise.all(actions.map(action => action.getTitle()));
					return all.length > 0 ? all : undefined;
				},
				10000,
				'the editor toolbar',
			);
			const expected = [
				'Kernel Workbench',
				'Configure',
				'Build',
				'Run in QEMU',
				'Debug in QEMU',
			];
			for (const title of expected) {
				assert.ok(
					titles.some(t => t === title || t.startsWith(`${title} (`)),
					`"${title}" in ${titles.join(' | ')}`,
				);
			}
		});

		it('right-click offers the Kernel Workbench menu, not the steps', async () => {
			const editor = new TextEditor();
			const driver = editor.getDriver();
			// From the keyboard, at the cursor: a pointer position may land on the minimap or
			// the scrollbar, which have menus of their own.
			// The input: a native edit context in recent VS Code, a textarea before.
			const input = await editor.findElement(By.css('.native-edit-context, .inputarea'));
			await input.sendKeys(Key.chord(Key.SHIFT, Key.F10));
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

		it('decodes a selected stack trace into a tab', async () => {
			const traceFile = path.join(tree(), 'kwb-trace.txt');
			fs.writeFileSync(
				traceFile,
				[
					'[    7.765288] Kernel panic - not syncing: sysrq triggered crash',
					'[    7.768643]  dump_stack_lvl (lib/dump_stack.c:94)',
					'[    7.769682]  sysrq_handle_crash (drivers/tty/sysrq.c:154)',
					'[    7.780000] ---[ end Kernel panic - not syncing ]---',
					'',
				].join('\n'),
			);
			try {
				await VSBrowser.instance.openResources(traceFile);
				await until(
					async () =>
						(await new EditorView().getOpenEditorTitles()).includes('kwb-trace.txt'),
					30000,
					'the trace to open',
				);
				const editor = new TextEditor();
				const input = await editor.findElement(By.css('.native-edit-context, .inputarea'));
				await input.sendKeys(Key.chord(Key.CONTROL, 'a'));
				await new Workbench().executeCommand('Kernel: Decode Stack Trace');
				const title = await until(
					async () =>
						(await new EditorView().getOpenEditorTitles()).find(t =>
							t.endsWith('.oops'),
						),
					30000,
					'the decoded trace tab',
				);
				assert.strictEqual(title, 'Kernel panic - not syncing sysrq triggered crash.oops');
				// The editor's text is not in the DOM to read; the frames also go to Problems.
				const problems = await new BottomBarPanel().openProblemsView();
				const markers = await until(
					async () => {
						const rows = await problems.getAllVisibleMarkers(MarkerType.Any);
						const texts = await Promise.all(rows.map(r => r.getText()));
						return texts.some(t => t.includes('sysrq_handle_crash'))
							? texts
							: undefined;
					},
					10000,
					'the frames in Problems',
				);
				assert.ok(
					markers.some(m => /frame 1: sysrq_handle_crash/.test(m) && /154/.test(m)),
					markers.join(' | '),
				);
				assert.ok(
					markers.some(m => /frame 0: dump_stack_lvl/.test(m)),
					markers.join(' | '),
				);
				await new BottomBarPanel().toggle(false);
			} finally {
				fs.rmSync(traceFile, { force: true });
			}
		});

		it('shows the open file’s history in the History tab, and opens a commit', async () => {
			// The last file opened (the trace) is untracked: its history would walk the whole tree.
			await VSBrowser.instance.openResources(path.join(tree(), 'kernel/sched/core.c'));
			const control = await until(
				() => new ActivityBar().getViewControl('History'),
				10000,
				'the History view control',
			);
			const view = await control.openView();
			const rows = await until(
				async () => {
					const section = (await view
						.getContent()
						.getSection('File History')) as CustomTreeSection;
					const items = await section.getVisibleItems();
					const texts = await Promise.all(items.map(i => i.getLabel()));
					return texts.length > 1 && !texts.includes('Loading history…')
						? texts
						: undefined;
				},
				60000,
				'the history of core.c',
			);
			// The tree is virtualized: only the rendered rows are visible, so no paging row here.
			assert.ok(rows.length > 3 && rows.every(r => r.trim()), rows.join(' | '));
			const section = (await view
				.getContent()
				.getSection('File History')) as CustomTreeSection;
			const first = (await section.getVisibleItems())[0];
			await first.click();
			const title = await until(
				async () =>
					(await new EditorView().getOpenEditorTitles()).find(t => t.endsWith('.diff')),
				30000,
				'the commit tab',
			);
			assert.match(title, /^[0-9a-f]{12} .*\.diff$/);
			await (await new ActivityBar().getViewControl('Explorer'))?.openView();
		});

		it('shows the cursor line’s last change in the Blame view', async () => {
			await VSBrowser.instance.openResources(path.join(tree(), 'kernel/sched/core.c'));
			const control = await until(
				() => new ActivityBar().getViewControl('History'),
				10000,
				'the History view control',
			);
			const view = await control.openView();
			const rows = await until(
				async () => {
					const section = (await view
						.getContent()
						.getSection('Blame')) as CustomTreeSection;
					await section.expand();
					const items = await section.getVisibleItems();
					const labels = await Promise.all(items.map(i => i.getLabel()));
					return labels.length >= 3 &&
						!labels.some(l => l.startsWith('Running git blame'))
						? labels
						: undefined;
				},
				60000,
				'the Blame view to follow the cursor',
			);
			// The line's text, the commit that last changed it, and the chain before it.
			assert.ok(rows[0].trim() && rows[1].trim(), rows.join(' | '));
			assert.match(
				rows[2],
				/^(No earlier changes: |Earlier changes to this line \()/,
				rows.join(' | '),
			);
			await (await new ActivityBar().getViewControl('Explorer'))?.openView();
		});

		after(async () => {
			await new EditorView().closeAllEditors();
		});
	});
});
