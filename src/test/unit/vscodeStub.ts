// A stand-in for the 'vscode' module, so unit tests can load the
// extension's modules in plain Node. Import it before the module under
// test:
//
//   import { stub, fakeContext } from './vscodeStub';
//   import { Settings } from '../../settings';
//
// Anything not defined below is a "do nothing" object: it can be called,
// constructed, extended and read from, and returns more of the same. The
// parts the extension reads values from are real: the workspace folders,
// settings (stub.settings, else the default), setting changes
// (stub.changeSettings), EventEmitter and Uri.file.
import Module = require('module');

const handler: ProxyHandler<any> = {
	get(target, prop) {
		if (prop === 'then') {
			return undefined; // not a promise: `await anything` resolves at once
		}
		if (prop === Symbol.toPrimitive) {
			return () => '';
		}
		if (prop === Symbol.iterator) {
			return [][Symbol.iterator];
		}
		if (!(prop in target)) {
			target[prop] = anything(); // stable, so `extends vscode.X` works
		}
		return target[prop];
	},
	apply: () => anything(),
	construct: () => anything(),
};

function anything(base: object = {}): any {
	// copy descriptors, not values, so getters stay live
	return new Proxy(
		Object.defineProperties(function () {}, Object.getOwnPropertyDescriptors(base)),
		handler,
	);
}

type Listener<T> = (e: T) => void;

class EventEmitter<T> {
	private listeners: Listener<T>[] = [];
	event = (listener: Listener<T>) => {
		this.listeners.push(listener);
		return { dispose: () => (this.listeners = this.listeners.filter(l => l !== listener)) };
	};
	fire(e: T) {
		this.listeners.forEach(l => l(e));
	}
	dispose() {
		this.listeners = [];
	}
}

const configurationChanged = new EventEmitter<{ affectsConfiguration: (s: string) => boolean }>();

export const stub = {
	/** Folders the extension sees as open. */
	workspaceFolders: [] as { uri: { fsPath: string }; name: string; index: number }[],
	/** kernelWorkbench.* settings, without the prefix; anything else is the default. */
	settings: {} as Record<string, unknown>,
	/** Change kernelWorkbench.* settings and tell the listeners, as VS Code does. */
	changeSettings(values: Record<string, unknown>) {
		Object.assign(stub.settings, values);
		configurationChanged.fire({
			affectsConfiguration: (section: string) => section === 'kernelWorkbench',
		});
	},
};

const uriFile = (p: string) => ({
	fsPath: p,
	path: p,
	scheme: 'file',
	toString: () => `file://${p}`,
});

export const vscode = anything({
	workspace: anything({
		get workspaceFolders() {
			return stub.workspaceFolders;
		},
		getConfiguration: () => ({
			get: (key: string, fallback?: unknown) =>
				key in stub.settings ? stub.settings[key] : fallback,
		}),
		onDidChangeConfiguration: configurationChanged.event,
	}),
	EventEmitter,
	Uri: anything({ file: uriFile }),
});

const load = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
	return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};

/** An ExtensionContext good enough for activate(). */
export function fakeContext(): any {
	const state = new Map<string, unknown>();
	const memento = {
		get: (k: string, fallback?: unknown) => (state.has(k) ? state.get(k) : fallback),
		update: async (k: string, v: unknown) => void state.set(k, v),
		keys: () => [...state.keys()],
	};
	return anything({
		subscriptions: [],
		workspaceState: memento,
		globalState: memento,
		extensionPath: process.cwd(),
	});
}

/** A workspace folder for `dir`, as VS Code passes it. */
export function folder(dir: string): any {
	return { uri: uriFile(dir), name: 'linux', index: 0 };
}
