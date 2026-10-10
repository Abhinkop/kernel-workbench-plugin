import * as vscode from 'vscode';
import { isKernelTree } from './kernelTree';

/** Called by VS Code when a workspace containing a Kbuild file is opened. */
export function activate(context: vscode.ExtensionContext): void {
	const folder = (vscode.workspace.workspaceFolders ?? []).find(workspaceFolder =>
		isKernelTree(workspaceFolder.uri.fsPath),
	);
	if (!folder) {
		return;
	}
	vscode.commands.executeCommand('setContext', 'kernelDev.active', true);
}

/** Called by VS Code when the extension is shut down. */
export function deactivate(): void {}
