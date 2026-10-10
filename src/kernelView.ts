import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isNative } from './arch';
import type { Kbuild } from './kbuild';
import type { Runner } from './runner';
import type { Settings } from './settings';

/** How a row's value is edited. The target rows route to their Select command. */
export interface OptionSpec {
	/** kernelWorkbench.<key>, or $arch, $variant and $config for the target */
	key: string;
	label: string;
	kind: 'enum';
}

interface ItemOptions {
	description?: string;
	icon?: string;
	color?: string;
	tooltip?: string | vscode.MarkdownString;
	contextValue?: string;
	children?: Item[];
	collapsed?: boolean;
	option?: OptionSpec;
	command?: vscode.Command;
}

/** A row of the Kernel view. A row with contextValue 'edit' opens its editor on a click. */
export class Item extends vscode.TreeItem {
	readonly children?: Item[];
	readonly option?: OptionSpec;

	constructor(label: string, options: ItemOptions = {}) {
		super(label, collapsibleState(options));
		this.description = options.description;
		if (options.icon) {
			const color = options.color ? new vscode.ThemeColor(options.color) : undefined;
			this.iconPath = new vscode.ThemeIcon(options.icon, color);
		}
		this.tooltip = options.tooltip;
		this.contextValue = options.contextValue;
		this.children = options.children;
		this.option = options.option;
		if (options.command) {
			this.command = options.command;
		} else if (options.contextValue === 'edit') {
			this.command = {
				command: 'kernelWorkbench.editItem',
				title: 'Change…',
				arguments: [this],
			};
		}
	}
}

function collapsibleState(options: ItemOptions): vscode.TreeItemCollapsibleState {
	if (!options.children) {
		return vscode.TreeItemCollapsibleState.None;
	}
	return options.collapsed
		? vscode.TreeItemCollapsibleState.Collapsed
		: vscode.TreeItemCollapsibleState.Expanded;
}

/** A row that runs a command when clicked. */
function action(
	label: string,
	command: string,
	icon: string,
	description?: string,
	tooltip?: string,
): Item {
	return new Item(label, {
		icon,
		description,
		tooltip: tooltip ?? `Click to ${label.toLowerCase()}`,
		contextValue: 'step',
		command: { command, title: label },
	});
}

/**
 * The Kernel view: the steps (Configure, Build, Run) and the other actions as rows
 * that run on a click, the
 * target (architecture, Debug/Release, base config) as rows that open their
 * picker, and the state of each step.
 */
export class KernelView implements vscode.TreeDataProvider<Item> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<Item | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	/** Kernel tasks whose process is running. */
	private readonly running = new Set<vscode.TaskExecution>();
	/** The last tool check: what is missing, how to install it, and the list to show. */
	private tools = { missing: '', command: '', list: [] as string[] };

	constructor(
		context: vscode.ExtensionContext,
		private readonly settings: Settings,
		private readonly kbuild: Kbuild,
		private readonly runner: Runner,
	) {
		context.subscriptions.push(
			this._onDidChangeTreeData,
			settings.onDidChange(() => this.refresh()),
			runner.onDidChange(() => this.refresh()),
			vscode.window.onDidOpenTerminal(() => this.refresh()),
			vscode.window.onDidCloseTerminal(() => this.refresh()),
			// Tracked from the events: when onDidEndTaskProcess fires, the task is still
			// listed in vscode.tasks.taskExecutions.
			vscode.tasks.onDidStartTaskProcess(e => {
				if (e.execution.task.source === 'kernel') {
					this.running.add(e.execution);
				}
				this.refresh();
			}),
			vscode.tasks.onDidEndTaskProcess(e => {
				this.running.delete(e.execution);
				this.refresh();
			}),
			vscode.tasks.onDidEndTask(e => {
				this.running.delete(e.execution);
				this.refresh();
			}),
		);
	}

	/** Shows the result of a tool check: the missing ones, or none. */
	setTools(missing: string, command: string, list: string[] = []): void {
		this.tools = { missing, command, list };
		this.refresh();
	}

	refresh(): void {
		vscode.commands.executeCommand('setContext', 'kernelWorkbench.busy', this.running.size > 0);
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(item: Item): vscode.TreeItem {
		return item;
	}

	getChildren(item?: Item): Item[] {
		if (item) {
			return item.children ?? [];
		}
		return [this.stepsGroup(), this.moreGroup(), this.targetGroup(), this.statusGroup()];
	}

	/** The target as the step rows name it: "arm64 Debug". */
	private target(): string {
		const settings = this.settings;
		return `${settings.arch} ${settings.variant === 'debug' ? 'Debug' : 'Release'}`;
	}

	stepsGroup(): Item {
		const settings = this.settings;
		const target = this.target();
		const configured = settings.configured();
		return new Item('Steps', {
			icon: 'list-ordered',
			children: [
				action(
					'Configure',
					'kernelWorkbench.configure',
					'gear',
					`${target} from ${path.basename(settings.config)}`,
					`Configure ${target} from ${settings.config} into ${settings.buildDir()}`,
				),
				action(
					'Build',
					'kernelWorkbench.build',
					'tools',
					configured ? target : `${target} (not configured yet)`,
				),
				this.runner.running
					? action('Stop VM', 'kernelWorkbench.stop', 'debug-stop', 'the VM is running')
					: action(
							'Run',
							'kernelWorkbench.run',
							'play',
							`${target} in QEMU`,
							`Boot the ${target} kernel in QEMU`,
						),
			],
		});
	}

	/** The other actions, collapsed: the Steps are what one does most. */
	moreGroup(): Item {
		return new Item('More', {
			icon: 'ellipsis',
			collapsed: true,
			children: [
				action(
					'menuconfig',
					'kernelWorkbench.menuconfig',
					'settings-gear',
					'',
					'Run make menuconfig in a terminal',
				),
				action(
					'nconfig',
					'kernelWorkbench.nconfig',
					'settings-gear',
					'',
					'Run make nconfig in a terminal',
				),
				action('Clean', 'kernelWorkbench.clean', 'trash', 'make clean'),
				action('Rebuild', 'kernelWorkbench.rebuild', 'refresh', 'make clean, then build'),
				action(
					'Full clean',
					'kernelWorkbench.mrproper',
					'clear-all',
					'make mrproper (removes .config)',
				),
				action('Build modules', 'kernelWorkbench.buildModules', 'package', 'make modules'),
				action(
					'Check tools',
					'kernelWorkbench.checkTools',
					'search',
					'are the required tools installed?',
				),
			],
		});
	}

	targetGroup(): Item {
		const settings = this.settings;
		const cross = isNative(settings.arch) ? '' : ' (cross)';
		return new Item('Target', {
			icon: 'target',
			children: [
				new Item('Architecture', {
					description: `${settings.arch}${cross}`,
					icon: 'chip',
					tooltip: 'kernelWorkbench.arch',
					contextValue: 'edit',
					option: { key: '$arch', label: 'Architecture', kind: 'enum' },
				}),
				new Item('Build', {
					description: settings.variant === 'debug' ? 'Debug' : 'Release',
					icon: settings.variant === 'debug' ? 'bug' : 'rocket',
					contextValue: 'edit',
					option: { key: '$variant', label: 'Build', kind: 'enum' },
				}),
				new Item('Base config', {
					description: path.basename(settings.config),
					icon: 'file-code',
					tooltip: settings.config,
					contextValue: 'edit',
					option: { key: '$config', label: 'Base config', kind: 'enum' },
				}),
			],
		});
	}

	statusGroup(): Item {
		const settings = this.settings;
		const configured = settings.configured();
		const image = configured ? this.kbuild.image(configured) : undefined;
		const built = image ? modifiedAt(image) : undefined;
		const items: Item[] = [];
		const busy = [...this.running][0];
		if (busy) {
			items.push(new Item('Running', { description: busy.task.name, icon: 'loading~spin' }));
		}
		items.push(
			new Item('Configured', {
				description: configured ? when(new Date(configured.configuredAt)) : 'not yet',
				icon: configured ? 'pass' : 'circle-large-outline',
				tooltip: configured
					? `From ${configured.config}\n${configured.buildDir}`
					: settings.buildDir(),
			}),
			new Item('Built', {
				description: image && built ? `${path.basename(image)}, ${when(built)}` : 'not yet',
				icon: built ? 'pass' : 'circle-large-outline',
				tooltip: image,
			}),
			new Item('VM', {
				description: this.runner.running ? 'running' : 'stopped',
				icon: this.runner.running ? 'vm-running' : 'vm',
				contextValue: this.runner.running ? 'vmRunning' : undefined,
			}),
			this.toolsRow(),
		);
		return new Item('Status', { icon: 'pulse', children: items });
	}

	/** The Tools row: all installed, or the missing ones listed, with Install inline. */
	private toolsRow(): Item {
		const tools = this.tools;
		if (!tools.missing) {
			return new Item('Tools', { description: 'all installed', icon: 'pass' });
		}
		return new Item('Tools', {
			description: `missing ${tools.list.length || ''}`.trim(),
			icon: 'warning',
			color: 'problemsWarningIcon.foreground',
			tooltip: tools.missing,
			contextValue: tools.command ? 'toolsMissing' : undefined,
			children: tools.list.map(tool => new Item(tool, { icon: 'circle-small' })),
			collapsed: true,
		});
	}
}

/** When a file was last written, if it exists. */
function modifiedAt(file: string): Date | undefined {
	try {
		return fs.statSync(file).mtime;
	} catch {
		return undefined;
	}
}

/** A date as the Status rows show it. */
function when(date: Date): string {
	return date.toLocaleString();
}

/** The Select command that a target row's "Change…" runs. */
const SELECT_COMMANDS: Record<string, string> = {
	$arch: 'kernelWorkbench.selectArch',
	$variant: 'kernelWorkbench.selectVariant',
	$config: 'kernelWorkbench.selectConfig',
};

/** Registers the Kernel view and the "Change…" action of its rows. */
export function registerKernelView(
	context: vscode.ExtensionContext,
	settings: Settings,
	kbuild: Kbuild,
	runner: Runner,
): KernelView {
	const view = new KernelView(context, settings, kbuild, runner);
	context.subscriptions.push(
		vscode.window.createTreeView('kernelWorkbench.kernel', {
			treeDataProvider: view,
			showCollapseAll: false,
		}),
		vscode.commands.registerCommand('kernelWorkbench.editItem', async (item?: Item) => {
			const command = item?.option && SELECT_COMMANDS[item.option.key];
			if (command) {
				await vscode.commands.executeCommand(command);
			}
		}),
	);
	return view;
}
