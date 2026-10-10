import * as vscode from 'vscode';
import type { KernelView } from './kernelView';
import type { Settings } from './settings';
import { describe, installCommand, missing } from './tools';

/** globalState key: false once the user chose "Don't Show Again". */
const NOTIFY_KEY = 'kernelWorkbench.toolNotifications';

/** Runs an install command in a terminal, where the user can confirm sudo. */
export function runInstall(settings: Settings, command: string): void {
	const terminal = vscode.window.createTerminal({
		name: 'Install kernel tools',
		cwd: settings.root,
	});
	terminal.show();
	terminal.sendText(command);
}

/**
 * Checks the host for everything the current selection needs: when the
 * extension loads and whenever the selection or a setting changes. The Kernel
 * view always shows the result; the notification is shown once per distinct
 * set of missing tools, unless turned off.
 *
 * @returns the check, to run again; `always` shows the result even when it is
 *   unchanged or everything is installed
 */
export function registerToolCheck(
	context: vscode.ExtensionContext,
	settings: Settings,
	kernelView: KernelView,
): (always: boolean) => Promise<void> {
	let lastShown = '';
	const checkTools = async (always: boolean): Promise<void> => {
		const absent = missing(settings);
		const text = describe(absent);
		const command = installCommand(absent);
		kernelView.setTools(
			text,
			command,
			absent.map(r =>
				r.pkg ? `${r.what} (${r.pkg})` : r.hint ? `${r.what}: ${r.hint}` : r.what,
			),
		);
		if (!absent.length) {
			lastShown = '';
			if (always) {
				vscode.window.showInformationMessage(
					`Kernel: all tools for ${settings.arch} are installed.`,
				);
			}
			return;
		}
		if (!always && (text === lastShown || context.globalState.get(NOTIFY_KEY) === false)) {
			return;
		}
		lastShown = text;
		const buttons = command ? ['Run Install Command', 'Copy Command'] : ['Show in Kernel View'];
		if (!always) {
			buttons.push("Don't Show Again");
		}
		const toolchain = settings.get('toolchain', 'gcc');
		const pick = await vscode.window.showWarningMessage(
			`Kernel Workbench: missing tools for ${settings.arch} (${toolchain}): ${text}.` +
				(command ? ` Install with: ${command}` : ''),
			...buttons,
		);
		if (pick === 'Run Install Command') {
			runInstall(settings, command);
		} else if (pick === 'Copy Command') {
			await vscode.env.clipboard.writeText(command);
		} else if (pick === 'Show in Kernel View') {
			await vscode.commands.executeCommand('kernelWorkbench.kernel.focus');
		} else if (pick === "Don't Show Again") {
			await context.globalState.update(NOTIFY_KEY, false);
		}
	};

	let pending: NodeJS.Timeout | undefined;
	context.subscriptions.push(
		settings.onDidChange(() => {
			clearTimeout(pending);
			pending = setTimeout(() => checkTools(false), 500);
		}),
	);
	void checkTools(false);
	return checkTools;
}
