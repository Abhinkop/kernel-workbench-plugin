import * as vscode from 'vscode';
import { Kbuild } from './kbuild';
import { isKernelTree } from './kernelTree';
import { KernelView, registerKernelView } from './kernelView';
import { Settings } from './settings';
import { registerToolCheck, runInstall } from './toolCheck';
import { installCommand, missing } from './tools';
import { pickArch, pickVariant, pickConfig } from './ui';

/** The extension's parts, returned by activate() for the tests. */
export interface KernelWorkbench {
	settings: Settings;
	kbuild: Kbuild;
	kernelView: KernelView;
	/** The tool check; `always` shows the result even when unchanged. */
	checkTools: (always: boolean) => Promise<void>;
}

/** Called by VS Code when a workspace containing a Kbuild file is opened. */
export function activate(context: vscode.ExtensionContext): KernelWorkbench | undefined {
	const folder = (vscode.workspace.workspaceFolders ?? []).find(workspaceFolder =>
		isKernelTree(workspaceFolder.uri.fsPath),
	);
	if (!folder) {
		return undefined;
	}
	vscode.commands.executeCommand('setContext', 'kernelWorkbench.active', true);

	const settings = new Settings(context, folder);
	const kbuild = new Kbuild(settings);
	const kernelView = registerKernelView(context, settings, kbuild);
	const checkTools = registerToolCheck(context, settings, kernelView);
	registerCommands(context, settings, kbuild, checkTools);
	return { settings, kbuild, kernelView, checkTools };
}

/** Called by VS Code when the extension is shut down. */
export function deactivate(): void {}

/** Registers the Kernel Workbench commands, disposed of when the extension is deactivated. */
function registerCommands(
	context: vscode.ExtensionContext,
	settings: Settings,
	kbuild: Kbuild,
	checkTools: (always: boolean) => Promise<void>,
): void {
	const commands: [string, (...args: any[]) => any][] = [
		['kernelWorkbench.selectArch', () => pickArch(settings)],
		['kernelWorkbench.selectVariant', () => pickVariant(settings)],
		['kernelWorkbench.selectConfig', () => pickConfig(settings)],
		['kernelWorkbench.configure', () => kbuild.configure()],
		['kernelWorkbench.build', () => kbuild.build()],
		[
			'kernelWorkbench.rebuild',
			async () => ((await kbuild.clean()) === 0 ? kbuild.build() : 1),
		],
		['kernelWorkbench.clean', () => kbuild.clean()],
		['kernelWorkbench.mrproper', () => kbuild.mrproper()],
		['kernelWorkbench.menuconfig', () => kbuild.interactiveConfig('menuconfig')],
		['kernelWorkbench.nconfig', () => kbuild.interactiveConfig('nconfig')],
		['kernelWorkbench.checkTools', () => checkTools(true)],
		[
			'kernelWorkbench.installTools',
			() => {
				const command = installCommand(missing(settings));
				if (command) {
					runInstall(settings, command);
				}
			},
		],
	];
	for (const [id, fn] of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	}
}
