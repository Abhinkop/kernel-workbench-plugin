import * as vscode from 'vscode';
import { isKernelTree } from './kernelTree';
import { Settings } from './settings';
import { pickArch, pickVariant, pickConfig } from './ui';

/** Called by VS Code when a workspace containing a Kbuild file is opened. */
export function activate(context: vscode.ExtensionContext): void {
	const folder = (vscode.workspace.workspaceFolders ?? []).find(workspaceFolder =>
		isKernelTree(workspaceFolder.uri.fsPath),
	);
	if (!folder) {
		return;
	}
	vscode.commands.executeCommand('setContext', 'kernelWorkbench.active', true);

	registerCommands(context, new Settings(context, folder));
}

/** Called by VS Code when the extension is shut down. */
export function deactivate(): void {}

/** Registers the Kernel Workbench commands, disposed of when the extension is deactivated. */
function registerCommands(context: vscode.ExtensionContext, settings: Settings): void {
	const commands: [string, (...args: any[]) => any][] = [
		['kernelWorkbench.selectArch', () => pickArch(settings)],
		['kernelWorkbench.selectVariant', () => pickVariant(settings)],
		['kernelWorkbench.selectConfig', () => pickConfig(settings)],
	];
	for (const [id, fn] of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	}
}
