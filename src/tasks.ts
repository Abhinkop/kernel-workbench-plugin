import * as vscode from 'vscode';

export const TASK_TYPE = 'kernel';

/**
 * Whether a step's terminal stays after it succeeds. A failed step's terminal
 * always stays, so its errors can be read.
 */
export function keepTerminal(folder: vscode.WorkspaceFolder): boolean {
	const afterTask = vscode.workspace
		.getConfiguration('kernelWorkbench', folder.uri)
		.get('terminal.afterTask');
	return afterTask === 'keep';
}

/**
 * The terminal a task ran in: VS Code names it after the task, with a
 * "Task - " prefix in some versions.
 */
export function taskTerminal(name: string): vscode.Terminal | undefined {
	return vscode.window.terminals.find(t => t.name === name || t.name === `Task - ${name}`);
}

export interface TaskOptions {
	problemMatcher?: string[];
	cwd?: string;
	env?: Record<string, string>;
	reveal?: vscode.TaskRevealKind;
	/** The task definition's step; the name when not given. */
	step?: string;
}

/**
 * Runs a command as a VS Code task (output in the terminal panel, problem
 * matcher applied) and resolves with its exit code. The terminal closes when
 * the step succeeds, unless kernelWorkbench.terminal.afterTask is "keep"; it
 * stays when the step fails.
 */
export async function runTask(
	folder: vscode.WorkspaceFolder,
	name: string,
	command: string,
	args: string[],
	options: TaskOptions = {},
): Promise<number> {
	const task = makeTask(folder, name, command, args, options);
	const execution = await vscode.tasks.executeTask(task);
	return new Promise(resolve => {
		const subscription = vscode.tasks.onDidEndTaskProcess(e => {
			if (e.execution === execution) {
				subscription.dispose();
				const code = e.exitCode ?? 1;
				if (code === 0 && !keepTerminal(folder)) {
					taskTerminal(name)?.dispose();
				}
				resolve(code);
			}
		});
	});
}

export function makeTask(
	folder: vscode.WorkspaceFolder,
	name: string,
	command: string,
	args: string[],
	options: TaskOptions = {},
): vscode.Task {
	const task = new vscode.Task(
		{ type: TASK_TYPE, step: options.step ?? name },
		folder,
		name,
		'kernel',
		new vscode.ProcessExecution(command, args, {
			cwd: options.cwd ?? folder.uri.fsPath,
			env: options.env,
		}),
		options.problemMatcher ?? [],
	);
	task.presentationOptions = {
		reveal: options.reveal ?? vscode.TaskRevealKind.Always,
		panel: vscode.TaskPanelKind.Dedicated,
		clear: true,
		showReuseMessage: false,
		// runTask() closes the terminal of a step that succeeded.
		close: false,
	};
	return task;
}

/** Shell-quotes for display and for `bash -c` strings. */
export function sq(s: string): string {
	return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
