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

interface UriParts {
	scheme?: string;
	path?: string;
	query?: string;
	fragment?: string;
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
	static parse(value: string): Uri {
		const m = /^([a-z][\w+.-]*):([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(value);
		if (!m) {
			throw new Error(`not a Uri: ${value}`);
		}
		return new Uri(m[1], m[2], m[3] ?? '', m[4] ?? '');
	}
	static from(parts: UriParts & { scheme: string }): Uri {
		return new Uri(parts.scheme, parts.path ?? '', parts.query ?? '', parts.fragment ?? '');
	}
	with(change: UriParts): Uri {
		return Uri.from({
			scheme: change.scheme ?? this.scheme,
			path: change.path ?? this.path,
			query: change.query ?? this.query,
			fragment: change.fragment ?? this.fragment,
		});
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

export class Position {
	constructor(
		readonly line: number,
		readonly character: number,
	) {}
}

export class Range {
	readonly start: Position;
	readonly end: Position;
	constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
		this.start = new Position(startLine, startCharacter);
		this.end = new Position(endLine, endCharacter);
	}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;

export class Diagnostic {
	source?: string;
	constructor(
		readonly range: Range,
		readonly message: string,
		readonly severity: number = DiagnosticSeverity.Error,
	) {}
}

export class DocumentLink {
	constructor(
		readonly range: Range,
		readonly target?: Uri,
	) {}
}

export class Location {
	constructor(
		readonly uri: Uri,
		readonly range: Range,
	) {}
}

export class TestMessage {
	location?: Location;
	constructor(readonly message: string) {}
}

/** A test item of a controller. */
export interface TestItem {
	id: string;
	label: string;
	uri?: Uri;
	description?: string;
	children: TestItemCollection;
}

export class TestItemCollection {
	private map = new Map<string, TestItem>();
	add(item: TestItem): void {
		this.map.set(item.id, item);
	}
	replace(items: TestItem[]): void {
		this.map = new Map(items.map(i => [i.id, i]));
	}
	get(id: string): TestItem | undefined {
		return this.map.get(id);
	}
	forEach(fn: (item: TestItem, collection: TestItemCollection) => void): void {
		this.map.forEach(item => fn(item, this));
	}
	get size(): number {
		return this.map.size;
	}
}

export class TestRunRequest {
	constructor(
		readonly include?: unknown[],
		readonly exclude?: unknown[],
	) {}
}

export const TestRunProfileKind = { Run: 1, Debug: 2, Coverage: 3 } as const;

/** A test run, and what was reported to it: [state, item id, message?]. */
export interface TestRun {
	request: TestRunRequest;
	results: [string, string, unknown?][];
	output: string;
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
export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;

export class CancellationTokenSource {
	private listeners: (() => void)[] = [];
	token = {
		isCancellationRequested: false,
		onCancellationRequested: (listener: () => void) => {
			this.listeners.push(listener);
			return { dispose() {} };
		},
	};
	cancel(): void {
		this.token.isCancellationRequested = true;
		this.listeners.forEach(l => l());
	}
	dispose(): void {}
}

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
	/** Installed extensions, by id, for extensions.getExtension. */
	extensions: {} as Record<string, unknown>,
	/** Documents shown with window.showTextDocument. */
	shown: [] as { uri: string; options: unknown }[],
	/** Debug configurations started with debug.startDebugging. */
	debugSessions: [] as Record<string, unknown>[],
	/** Diagnostics set through languages.createDiagnosticCollection, by '<collection>|<uri>'. */
	diagnostics: new Map<string, unknown[]>(),
	/** Text document content providers, by scheme. */
	contentProviders: {} as Record<string, ContentProvider>,
	/** Document link providers registered. */
	linkProviders: [] as unknown[],
	/** Every test run that ended. */
	testRuns: [] as TestRun[],
};

interface ContentProvider {
	provideTextDocumentContent(uri: Uri): string;
}

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
const onDidTerminateDebugSession = new EventEmitter<{ configuration: Record<string, unknown> }>();

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
	ViewColumn,
	ProgressLocation,
	CancellationTokenSource,
	Position,
	Range,
	Diagnostic,
	DiagnosticSeverity,
	DocumentLink,
	Location,
	TestMessage,
	TestRunRequest,
	TestRunProfileKind,

	workspace: {
		workspaceFolders: [] as WorkspaceFolder[],
		getConfiguration: (section?: string) => configuration(section),
		onDidChangeConfiguration: onDidChangeConfiguration.event,
		registerTextDocumentContentProvider: (scheme: string, provider: ContentProvider) => {
			state.contentProviders[scheme] = provider;
			return { dispose: () => delete state.contentProviders[scheme] };
		},
		/** A document: a Uri's content from its scheme's provider, or the content given. */
		openTextDocument: async (target: Uri | { content?: string }) => {
			const uri = target instanceof Uri ? target : new Uri('untitled', 'Untitled-1');
			const text =
				target instanceof Uri
					? (state.contentProviders[uri.scheme]?.provideTextDocumentContent(uri) ?? '')
					: (target.content ?? '');
			const lines = text.split('\n');
			return {
				uri,
				getText: () => text,
				lineCount: lines.length,
				lineAt: (i: number) => ({ text: lines[i] }),
			};
		},
	},

	languages: {
		createDiagnosticCollection: (name: string) => {
			const key = (uri: Uri) => `${name}|${uri.toString()}`;
			const clear = () => {
				for (const k of [...state.diagnostics.keys()]) {
					if (k.startsWith(`${name}|`)) {
						state.diagnostics.delete(k);
					}
				}
			};
			return {
				name,
				set: (uri: Uri, list: unknown[]) => void state.diagnostics.set(key(uri), list),
				delete: (uri: Uri) => void state.diagnostics.delete(key(uri)),
				clear,
				dispose: clear,
			};
		},
		registerDocumentLinkProvider: (_selector: unknown, provider: unknown) => {
			state.linkProviders.push(provider);
			return {
				dispose: () => {
					state.linkProviders = state.linkProviders.filter(p => p !== provider);
				},
			};
		},
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
		withProgress: async <T>(
			_options: unknown,
			task: (progress: { report(v: unknown): void }, token: unknown) => Promise<T>,
		) => task({ report() {} }, new CancellationTokenSource().token),
		/** The editor the extension sees as active; tests set it. */
		activeTextEditor: undefined as
			| {
					document: { uri: Uri; getText?: (range?: unknown) => string };
					selection?: { isEmpty: boolean };
			  }
			| undefined,
		showTextDocument: async (target: Uri | { uri: Uri }, options?: unknown) => {
			const uri = 'uri' in target ? target.uri : target;
			state.shown.push({ uri: uri.toString(), options });
			return { document: { uri } };
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

	tests: {
		createTestController: (id: string, label: string) => ({
			id,
			label,
			items: new TestItemCollection(),
			profiles: [] as { label: string; kind: number; handler: unknown }[],
			refreshHandler: undefined as unknown,
			createRunProfile(label: string, kind: number, handler: unknown) {
				const profile = { label, kind, handler };
				this.profiles.push(profile);
				return profile;
			},
			createTestItem: (itemId: string, itemLabel: string, uri?: Uri): TestItem => ({
				id: itemId,
				label: itemLabel,
				uri,
				children: new TestItemCollection(),
			}),
			createTestRun: (request: TestRunRequest) => {
				const run: TestRun = { request, results: [], output: '' };
				return {
					passed: (t: TestItem) => run.results.push(['passed', t.id]),
					failed: (t: TestItem, m: unknown) => run.results.push(['failed', t.id, m]),
					skipped: (t: TestItem) => run.results.push(['skipped', t.id]),
					errored: (t: TestItem, m: unknown) => run.results.push(['errored', t.id, m]),
					started() {},
					enqueued() {},
					appendOutput: (s: string) => (run.output += s),
					end: () => state.testRuns.push(run),
				};
			},
			dispose() {},
		}),
	},

	extensions: {
		getExtension: (id: string) => state.extensions[id],
	},

	debug: {
		onDidTerminateDebugSession: onDidTerminateDebugSession.event,
		startDebugging: async (_folder: unknown, configuration: Record<string, unknown>) => {
			state.debugSessions.push(configuration);
			return true;
		},
		activeDebugSession: undefined,
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
	state.extensions = {};
	state.shown = [];
	state.debugSessions = [];
	state.diagnostics.clear();
	state.contentProviders = {};
	state.linkProviders = [];
	state.testRuns = [];
	vscode.window.activeTextEditor = undefined;
	state.commands.clear();
	vscode.workspace.workspaceFolders = [];
	for (const emitter of [
		onDidChangeConfiguration,
		onDidOpenTerminal,
		onDidCloseTerminal,
		onDidStartTaskProcess,
		onDidEndTaskProcess,
		onDidEndTask,
		onDidTerminateDebugSession,
	]) {
		emitter.dispose();
	}
}

/** Queue answers for the next prompts (a function gets the items offered). */
export function answer(...answers: unknown[]): void {
	state.answers.push(...answers);
}

/** A file Uri, typed as VS Code's, for calling the extension's functions. */
export function fileUri(p: string): vscodeTypes.Uri {
	return Uri.file(p) as unknown as vscodeTypes.Uri;
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
