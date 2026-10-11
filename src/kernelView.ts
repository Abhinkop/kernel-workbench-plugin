import * as vscode from 'vscode';
import * as path from 'path';
import { isNative } from './arch';
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

/**
 * The Kernel view: the target (architecture, Debug/Release, base config) as
 * rows that show their value and open their picker on a click.
 */
export class KernelView implements vscode.TreeDataProvider<Item> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<Item | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		context: vscode.ExtensionContext,
		private readonly settings: Settings,
	) {
		context.subscriptions.push(
			this._onDidChangeTreeData,
			settings.onDidChange(() => this.refresh()),
		);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(item: Item): vscode.TreeItem {
		return item;
	}

	getChildren(item?: Item): Item[] {
		return item ? (item.children ?? []) : [this.targetGroup()];
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
): KernelView {
	const view = new KernelView(context, settings);
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
