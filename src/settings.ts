import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ARCHES, archInfo, isNative } from './arch';

/**
 * Everything the user can set lives in VS Code settings (kernelWorkbench.*),
 * so it is configured once at user level and works in every kernel tree. The
 * current selection (arch, variant, config) is per-workspace UI state, not a
 * file. Configure records the exact make arguments in the build directory;
 * Build reuses them.
 */

export type Variant = 'debug' | 'release';

/** What Configure recorded in <buildDir>/.kernel-workbench.json. */
export interface Configured {
	arch: string;
	variant: Variant;
	/** base config target or file */
	config: string;
	/** absolute */
	buildDir: string;
	/** O=, ARCH=, toolchain and user make args */
	makeArgs: string[];
	configuredAt: string;
}

const STATE_FILE = '.kernel-workbench.json';

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

	/**
	 * make arguments for a fresh Configure of the current selection. ARCH and
	 * CROSS_COMPILE are always explicit so the environment cannot change what
	 * gets built.
	 */
	makeArgsForConfigure(): string[] {
		const arch = this.arch;
		const info = archInfo(arch);
		const args = [`O=${this.buildDir()}`, `ARCH=${info.kernelArch}`];
		const ccache = this.get('make.ccache', false);
		if (this.get('toolchain', 'gcc') === 'llvm') {
			args.push('LLVM=1', 'CROSS_COMPILE=');
			if (ccache) {
				args.push('CC=ccache clang');
			}
		} else {
			const prefixes = this.get<Record<string, string>>('crossCompile', {});
			const prefix = prefixes[arch] ?? (isNative(arch) ? '' : info.gccPrefix);
			args.push(`CROSS_COMPILE=${prefix}`);
			if (ccache) {
				args.push(`CC=ccache ${prefix}gcc`);
			}
		}
		return args.concat(this.get<string[]>('make.args', []));
	}

	/**
	 * make arguments for building a configured tree: the toolchain part
	 * recorded at Configure (O=, ARCH=, LLVM=, CROSS_COMPILE=, CC=), which the
	 * .config was made with, and the extra arguments as they are set now, so
	 * that a change such as W=1 applies to the next Build.
	 */
	makeArgs(state: Configured): string[] {
		const base: string[] = [];
		for (const arg of state.makeArgs) {
			if (!/^(O|ARCH|LLVM|CROSS_COMPILE|CC)=/.test(arg)) {
				break;
			}
			base.push(arg);
		}
		return base.concat(this.get<string[]>('make.args', []));
	}

	/** make -j: kernelWorkbench.make.jobs, or the number of CPUs. */
	jobs(): string {
		const jobs = this.get('make.jobs', 0);
		return `-j${jobs > 0 ? jobs : os.cpus().length}`;
	}

	// --- recorded configure state -------------------------------------------

	/** What Configure recorded for the current selection, if it has run. */
	configured(): Configured | undefined {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.buildDir(), STATE_FILE), 'utf8'));
		} catch {
			return undefined;
		}
	}

	/** Forgets what Configure recorded for the current selection. */
	clearConfigured(): void {
		fs.rmSync(path.join(this.buildDir(), STATE_FILE), { force: true });
		this._onDidChange.fire();
	}

	saveConfigured(state: Configured): void {
		fs.mkdirSync(state.buildDir, { recursive: true });
		const file = path.join(state.buildDir, STATE_FILE);
		fs.writeFileSync(file, JSON.stringify(state, null, '\t') + '\n');
		this._onDidChange.fire();
	}
}

export { Settings };
