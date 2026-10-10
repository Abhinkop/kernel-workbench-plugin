import * as vscode from 'vscode';
import { isKernelTree } from './kernelTree';

export function activate(context: vscode.ExtensionContext): void {
	const folder = (vscode.workspace.workspaceFolders ?? []).find(f => isKernelTree(f.uri.fsPath));
	if (!folder) {
		return;
	}
	vscode.commands.executeCommand('setContext', 'kernelDev.active', true);
}

export function deactivate(): void {}
