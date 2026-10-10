// A small, behaving stand-in for the `vscode` module, so the extension's
// modules can be unit-tested under plain Node. It keeps state that tests
// can inspect (prompts shown, settings, commands registered and executed)
// and answers prompts from a queue (`answer(...)`). setup.ts makes
// require('vscode') return it and resets it before every test.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';

type Listener<T> = (e: T) => void;

export class EventEmitter<T = void> {
	private listeners: Listener<T>[] = [];
	event = (listener: Listener<T>) => {
		this.listeners.push(listener);
		return { dispose: () => (this.listeners = this.listeners.filter(l => l !== listener)) };
	};
	fire(e: T): void {
		for (const listener of [...this.listeners]) {
			listener(e);
		}
	}
	dispose(): void {
		this.listeners = [];
	}
}

export class Uri {
	constructor(
		readonly scheme: string,
		readonly path: string,
		readonly query = '',
		readonly fragment = '',
	) {}
	get fsPath(): string {
		return this.path;
	}
	static file(p: string): Uri {
		return new Uri('file', path.resolve(p));
	}
	toString(): string {
		const query = this.query ? `?${this.query}` : '';
		const fragment = this.fragment ? `#${this.fragment}` : '';
		return `${this.scheme}:${this.path}${query}${fragment}`;
	}
}

export class ThemeColor {
	constructor(readonly id: string) {}
}

export class ThemeIcon {
	constructor(
		readonly id: string,
		readonly color?: ThemeColor,
	) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class TreeItem {
	description?: string | boolean;
	iconPath?: unknown;
	tooltip?: unknown;
	contextValue?: string;
	command?: { command: string; title: string; arguments?: unknown[] };
	constructor(
		public label: string,
		public collapsibleState: number = TreeItemCollapsibleState.None,
	) {}
}

export interface WorkspaceFolder {
	uri: Uri;
	name: string;
	index: number;
}

/** A tree view created by the extension, with the provider it shows. */
export interface TreeView {
	id: string;
	provider: unknown;
	visible: boolean;
	dispose(): void;
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const TaskRevealKind = { Always: 1, Silent: 2, Never: 3 } as const;
export const TaskPanelKind = { Shared: 1, Dedicated: 2, New: 3 } as const;
export const TerminalLocation = { Panel: 1, Editor: 2 } as const;

export class ProcessExecution {
	constructor(
		readonly process: string,
		readonly args: string[],
		readonly options: { cwd?: string; env?: Record<string, string> } = {},
	) {}
}

export class Task {
	presentationOptions: Record<string, unknown> = {};
	/** Set when the process ends. */
	exitCode?: number;
	/** What the process printed. */
	output = '';
	constructor(
		readonly definition: Record<string, unknown>,
		readonly scope: unknown,
		readonly name: string,
		readonly source: string,
		readonly execution: ProcessExecution,
		readonly problemMatchers: string[] = [],
	) {}
}

/** A terminal the extension created, and what it did with it. */
export interface Terminal {
	name: string;
	options: Record<string, unknown>;
	shown: boolean;
	sent: string[];
	disposed: boolean;
	exitStatus?: unknown;
	show(): void;
	sendText(text: string): void;
	dispose(): void;
}

/** A prompt the extension showed: what kind, its message, the items offered. */
export interface Prompt {
	kind: 'info' | 'warning' | 'error' | 'quickpick' | 'input' | 'open';
	message: string | undefined;
	items: unknown[];
	options: unknown;
}

export const state = {
	/** Answers for the next prompts, in order; a function gets the items offered. */
	answers: [] as unknown[],
	/** Every prompt shown. */
	log: [] as Prompt[],
	/** Settings, by full key: 'kernelWorkbench.arch' -> value. */
	config: {} as Record<string, unknown>,
	/** Registered commands, by id. */
	commands: new Map<string, (...args: any[]) => unknown>(),
	/** Every executeCommand call, registered or not (e.g. setContext). */
	executed: [] as { id: string; args: unknown[] }[],
	/** Tree views, by 'tree:<view id>'. */
	providers: {} as Record<string, TreeView>,
	/** Every terminal created, disposed ones included. */
	terminals: [] as Terminal[],
	/** Every task executed. */
	tasks: [] as Task[],
	/** executeTask runs the process for real; a number instead is reported as the exit code. */
	runTasks: true as boolean | number,
	/** What was last copied with env.clipboard. */
	clipboard: '',
};

function ask(
	kind: Prompt['kind'],
	message: string | undefined,
	items: unknown[],
	options: unknown,
) {
	state.log.push({ kind, message, items, options });
	let a = state.answers.length ? state.answers.shift() : undefined;
	if (typeof a === 'function') {
		a = a(items, message, options);
	}
	return Promise.resolve(a);
}

/** Only the string items of show*Message: `(message, ...items, options?)`. */
const message =
	(kind: Prompt['kind']) =>
	(text: string, ...items: unknown[]) =>
		ask(
			kind,
			text,
			items.filter(i => typeof i === 'string'),
			items.find(i => typeof i === 'object'),
		);

const onDidChangeConfiguration = new EventEmitter<{
	affectsConfiguration: (section: string, scope?: unknown) => boolean;
}>();
const onDidOpenTerminal = new EventEmitter<Terminal>();
const onDidCloseTerminal = new EventEmitter<Terminal>();
interface TaskExecution {
	task: Task;
}
const onDidStartTaskProcess = new EventEmitter<{ execution: TaskExecution; processId: number }>();
const onDidEndTaskProcess = new EventEmitter<{ execution: TaskExecution; exitCode: number }>();
const onDidEndTask = new EventEmitter<{ execution: TaskExecution }>();

// Setting defaults, as VS Code takes them from the manifest.
const DEFAULTS: Record<string, unknown> = {};
{
	const pkg = JSON.parse(
		fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'),
	);
	const sections = pkg.contributes?.configuration ?? [];
	for (const section of Array.isArray(sections) ? sections : [sections]) {
		for (const [key, schema] of Object.entries(section.properties ?? {})) {
			DEFAULTS[key] = (schema as { default?: unknown }).default;
		}
	}
}

function configuration(section?: string) {
	const key = (k: string) => (section ? `${section}.${k}` : k);
	return {
		get: (k: string, fallback?: unknown) =>
			state.config[key(k)] !== undefined
				? state.config[key(k)]
				: DEFAULTS[key(k)] !== undefined
					? DEFAULTS[key(k)]
					: fallback,
		has: (k: string) => state.config[key(k)] !== undefined,
		inspect: (k: string) => ({ key: key(k), globalValue: state.config[key(k)] }),
		update: async (k: string, value: unknown) => {
			if (value === undefined) {
				delete state.config[key(k)];
			} else {
				state.config[key(k)] = value;
			}
			onDidChangeConfiguration.fire({ affectsConfiguration: s => key(k).startsWith(s) });
		},
	};
}

export const vscode = {
	EventEmitter,
	Uri,
	ThemeColor,
	ThemeIcon,
	TreeItem,
	TreeItemCollapsibleState,
	ConfigurationTarget,
	ProcessExecution,
	Task,
	TaskRevealKind,
	TaskPanelKind,
	TerminalLocation,

	workspace: {
		workspaceFolders: [] as WorkspaceFolder[],
		getConfiguration: (section?: string) => configuration(section),
		onDidChangeConfiguration: onDidChangeConfiguration.event,
	},

	window: {
		showInformationMessage: message('info'),
		showWarningMessage: message('warning'),
		showErrorMessage: message('error'),
		showQuickPick: (items: unknown[] | Promise<unknown[]>, options?: { title?: string }) =>
			Promise.resolve(items).then(it => ask('quickpick', options?.title, it, options)),
		showInputBox: (options?: { title?: string; prompt?: string }) =>
			ask('input', options?.title ?? options?.prompt, [], options),
		showOpenDialog: (options?: { title?: string }) => ask('open', options?.title, [], options),
		createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
			const view: TreeView = {
				id,
				provider: options.treeDataProvider,
				visible: true,
				dispose() {},
			};
			state.providers[`tree:${id}`] = view;
			return view;
		},
		get terminals(): Terminal[] {
			return state.terminals.filter(t => !t.disposed);
		},
		createTerminal: (options: { name: string } & Record<string, unknown>) => {
			const terminal: Terminal = {
				name: options.name,
				options,
				shown: false,
				sent: [],
				disposed: false,
				show() {
					this.shown = true;
				},
				sendText(text: string) {
					this.sent.push(text);
				},
				dispose() {
					this.disposed = true;
					onDidCloseTerminal.fire(this);
				},
			};
			state.terminals.push(terminal);
			onDidOpenTerminal.fire(terminal);
			return terminal;
		},
		onDidOpenTerminal: onDidOpenTerminal.event,
		onDidCloseTerminal: onDidCloseTerminal.event,
	},

	tasks: {
		onDidStartTaskProcess: onDidStartTaskProcess.event,
		onDidEndTaskProcess: onDidEndTaskProcess.event,
		onDidEndTask: onDidEndTask.event,
		taskExecutions: [] as TaskExecution[],
		/**
		 * Runs the task's process for real (unless state.runTasks says otherwise), in a
		 * dedicated terminal named after it, and reports the exit code through the events.
		 */
		executeTask: async (task: Task): Promise<TaskExecution> => {
			const execution: TaskExecution = { task };
			state.tasks.push(task);
			// Like VS Code, a dedicated terminal named after the task, reused.
			if (!vscode.window.terminals.some(t => t.name === task.name)) {
				vscode.window.createTerminal({ name: task.name });
			}
			setImmediate(() => {
				onDidStartTaskProcess.fire({ execution, processId: 1 });
				const finish = (code: number) => {
					task.exitCode = code;
					onDidEndTaskProcess.fire({ execution, exitCode: code });
					onDidEndTask.fire({ execution });
				};
				if (state.runTasks !== true) {
					finish(typeof state.runTasks === 'number' ? state.runTasks : 0);
					return;
				}
				const { process: command, args, options } = task.execution;
				const child = spawn(command, args, {
					cwd: options.cwd,
					env: { ...process.env, ...(options.env ?? {}) },
				});
				child.stdout.on('data', data => (task.output += data));
				child.stderr.on('data', data => (task.output += data));
				child.on('close', code => finish(code ?? 1));
			});
			return execution;
		},
	},

	env: {
		clipboard: {
			readText: async () => state.clipboard,
			writeText: async (text: string) => {
				state.clipboard = text;
			},
		},
	},

	commands: {
		registerCommand: (id: string, callback: (...args: any[]) => unknown) => {
			state.commands.set(id, callback);
			return { dispose: () => state.commands.delete(id) };
		},
		executeCommand: async (id: string, ...args: unknown[]) => {
			state.executed.push({ id, args });
			const callback = state.commands.get(id);
			return callback ? callback(...args) : undefined;
		},
		getCommands: async () => [...state.commands.keys()],
	},
};

/** Reset everything between tests. */
export function reset(): void {
	state.answers = [];
	state.log = [];
	state.config = {};
	state.executed = [];
	state.providers = {};
	state.terminals = [];
	state.tasks = [];
	state.runTasks = true;
	state.clipboard = '';
	state.commands.clear();
	vscode.workspace.workspaceFolders = [];
	for (const emitter of [
		onDidChangeConfiguration,
		onDidOpenTerminal,
		onDidCloseTerminal,
		onDidStartTaskProcess,
		onDidEndTaskProcess,
		onDidEndTask,
	]) {
		emitter.dispose();
	}
}

/** Queue answers for the next prompts (a function gets the items offered). */
export function answer(...answers: unknown[]): void {
	state.answers.push(...answers);
}

/** A workspace folder for `dir`, as VS Code passes it. */
export function workspaceFolder(dir: string): vscodeTypes.WorkspaceFolder {
	const folder: WorkspaceFolder = { uri: Uri.file(dir), name: path.basename(dir), index: 0 };
	return folder as unknown as vscodeTypes.WorkspaceFolder;
}

/** An ExtensionContext good enough for activate(): subscriptions and the two mementos. */
export function extensionContext(): vscodeTypes.ExtensionContext {
	const memento = () => {
		const values = new Map<string, unknown>();
		return {
			get: (k: string, fallback?: unknown) => (values.has(k) ? values.get(k) : fallback),
			update: async (k: string, v: unknown) => void values.set(k, v),
			keys: () => [...values.keys()],
		};
	};
	const context = {
		subscriptions: [] as { dispose(): unknown }[],
		extensionPath: path.resolve(__dirname, '../../..'),
		workspaceState: memento(),
		globalState: memento(),
	};
	return context as unknown as vscodeTypes.ExtensionContext;
}
