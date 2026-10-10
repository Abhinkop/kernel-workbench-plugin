import * as vscode from 'vscode';
import * as path from 'path';
import { ARCHES, isNative } from './arch';

/**
 * Everything the user can set lives in VS Code settings (kernelWorkbench.*),
 * so it is configured once at user level and works in every kernel tree. The
 * current selection (arch, variant, config) is per-workspace UI state, not a
 * file.
 */

export type Variant = 'debug' | 'release';

class Settings {
	readonly context: vscode.ExtensionContext;
	readonly folder: vscode.WorkspaceFolder;
	readonly root: string;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	/** Fires when the selection or a kernelWorkbench setting changes. */
	readonly onDidChange = this._onDidChange.event;

	constructor(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder) {
		this.context = context;
		this.folder = folder;
		this.root = folder.uri.fsPath;
		context.subscriptions.push(
			this._onDidChange,
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('kernelWorkbench', folder.uri)) {
					this._onDidChange.fire();
				}
			}),
		);
	}

	/**
	 * A kernelWorkbench.* setting, or `fallback` when it is not set. The
	 * fallback also gives the type: get('variant', 'debug') is a string. For
	 * objects and arrays name the type: get<Record<string, string>>('x', {}).
	 */
	get(key: string, fallback: string): string;
	get(key: string, fallback: number): number;
	get(key: string, fallback: boolean): boolean;
	get<T>(key: string, fallback: T): T;
	get<T>(key: string, fallback: T): T {
		const v = vscode.workspace.getConfiguration('kernelWorkbench', this.folder.uri).get<T>(key);
		return v === undefined || v === null ? fallback : v;
	}

	// --- selection ---------------------------------------------------------

	get arch(): string {
		const a =
			this.context.workspaceState.get<string>('kernelWorkbench.arch') ||
			this.get('arch', '') ||
			Object.keys(ARCHES).find(isNative) ||
			'x86_64';
		return ARCHES[a] ? a : 'x86_64';
	}

	get variant(): Variant {
		const v =
			this.context.workspaceState.get<string>('kernelWorkbench.variant') ||
			this.get('variant', 'debug');
		return v === 'release' ? 'release' : 'debug';
	}

	/** Base config for the current arch: a make target or a .config path. */
	get config(): string {
		return (
			this.context.workspaceState.get<string>(`kernelWorkbench.config.${this.arch}`) ||
			this.get('configure.defconfig', 'defconfig')
		);
	}

	async select(what: 'arch' | 'variant' | 'config', value: string) {
		const key =
			what === 'config' ? `kernelWorkbench.config.${this.arch}` : `kernelWorkbench.${what}`;
		await this.context.workspaceState.update(key, value);
		this._onDidChange.fire(undefined);
	}

	// --- derived -----------------------------------------------------------

	buildDir(arch: string = this.arch, variant: Variant = this.variant) {
		const tmpl = this.get('buildDirectory', 'build/${arch}/${variant}');
		return path.resolve(
			this.root,
			tmpl.replace(/\$\{arch\}/g, arch).replace(/\$\{variant\}/g, variant),
		);
	}
}

export { Settings };
