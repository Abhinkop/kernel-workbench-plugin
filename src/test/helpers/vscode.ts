// A small, behaving stand-in for the `vscode` module, so the extension's
// modules can be unit-tested under plain Node. It keeps state that tests
// can inspect (prompts shown, settings, commands registered and executed)
// and answers prompts from a queue (`answer(...)`). setup.ts makes
// require('vscode') return it and resets it before every test.
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

export interface WorkspaceFolder {
	uri: Uri;
	name: string;
	index: number;
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
	state.commands.clear();
	vscode.workspace.workspaceFolders = [];
	onDidChangeConfiguration.dispose();
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
