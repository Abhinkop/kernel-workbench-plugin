import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { archInfo } from './arch';
import { updateCompileCommands } from './clangd';
import type { Configured, Settings } from './settings';
import { runTask, sq } from './tasks';
import { buildRequirements, describe, installCommand } from './tools';

/** Runs kbuild on the selected target, as steps in the terminal. */
export class Kbuild {
	readonly folder: vscode.WorkspaceFolder;
	readonly root: string;

	constructor(private readonly settings: Settings) {
		this.folder = settings.folder;
		this.root = settings.root;
	}

	/** A make command line: the arguments, -j, and the targets. */
	make(makeArgs: string[], ...targets: string[]): string {
		return ['make', ...makeArgs, this.settings.jobs(), ...targets].map(sq).join(' ');
	}

	/**
	 * Configure: base config -> fragments -> variant and user options -> olddefconfig.
	 * Records the make arguments so that Build uses the same ones. Afterwards lists the
	 * options Kconfig refused.
	 */
	async configure(): Promise<number> {
		const settings = this.settings;
		const { arch, variant, config } = settings;
		const makeArgs = settings.makeArgsForConfigure();
		if (!this.checkTools(makeArgs, arch)) {
			return 1;
		}
		const out = settings.buildDir();
		const dotconfig = path.join(out, '.config');
		const base = path.resolve(this.root, config);
		const options: Record<string, string> = {
			...(variant === 'debug'
				? settings.get<Record<string, string>>('configure.debugOptions', {})
				: settings.get<Record<string, string>>('configure.releaseOptions', {})),
			...settings.get<Record<string, string>>('configure.options', {}),
		};
		const fragments = settings.get<string[]>('configure.fragments', []);

		const script = [
			'set -e',
			`mkdir -p ${sq(out)}`,
			`echo "==> ${arch} ${variant}: ${config}"`,
			fs.existsSync(base) && fs.statSync(base).isFile()
				? `cp ${sq(base)} ${sq(dotconfig)}`
				: this.make(makeArgs, ...config.split(/\s+/).filter(Boolean)),
		];
		if (fragments.length) {
			script.push(
				'echo "==> merging fragments"',
				`ARCH=${sq(archInfo(arch).kernelArch)} scripts/kconfig/merge_config.sh -m ` +
					`-O ${sq(out)} ${sq(dotconfig)} ` +
					fragments.map(f => sq(path.resolve(this.root, f))).join(' '),
			);
		}
		const optionArgs = scriptsConfigArgs(options);
		if (optionArgs.length) {
			script.push(
				`echo "==> applying ${Object.keys(options).length} options"`,
				`scripts/config --file ${sq(dotconfig)} ${optionArgs.map(sq).join(' ')}`,
			);
		}
		script.push(
			this.make(makeArgs, 'olddefconfig'),
			// Kconfig silently drops options with unmet dependencies; say so.
			...Object.entries(options).map(([name, want]) => {
				const got = want === 'n' ? 'n|undef' : want === 'y' || want === 'm' ? want : '.*';
				return (
					`s=$(scripts/config --file ${sq(dotconfig)} -s ${sq(name)}); ` +
					`echo "$s" | grep -Eqx '${got}' || ` +
					`echo "warning: CONFIG_${name}=${want} requested, got $s (dependency not met?)"`
				);
			}),
			`echo "==> configured ${dotconfig}"`,
		);

		const code = await runTask(this.folder, `Configure ${arch} ${variant}`, 'bash', [
			'-c',
			script.join('\n'),
		]);
		if (code === 0) {
			settings.saveConfigured({
				arch,
				variant,
				config,
				buildDir: out,
				makeArgs,
				configuredAt: new Date().toISOString(),
			});
		}
		return code;
	}

	/**
	 * Build with the arguments recorded by Configure (configuring first if needed), with
	 * the compiler's errors and warnings in the Problems panel, then refresh
	 * compile_commands.json for clangd.
	 */
	async build(): Promise<number> {
		let state = this.settings.configured();
		if (!state) {
			if ((await this.configure()) !== 0) {
				return 1;
			}
			state = this.settings.configured();
			if (!state) {
				return 1;
			}
		}
		if (!this.checkTools(this.settings.makeArgs(state), state.arch)) {
			return 1;
		}
		const script = [
			'set -e',
			this.make(this.settings.makeArgs(state)),
			this.make(this.settings.makeArgs(state), 'compile_commands.json'),
			`echo "==> ${state.arch} ${state.variant} built"`,
		].join('\n');
		const code = await runTask(
			this.folder,
			`Build ${state.arch} ${state.variant}`,
			'bash',
			['-c', script],
			{ problemMatcher: ['$gcc'] },
		);
		if (code === 0) {
			await updateCompileCommands(this.root, state);
		}
		return code;
	}

	/** make clean on the configured build; nothing to do before Configure. */
	async clean(): Promise<number> {
		const state = this.settings.configured();
		if (!state) {
			return 0;
		}
		const script = this.make(this.settings.makeArgs(state), 'clean');
		return runTask(this.folder, `Clean ${state.arch} ${state.variant}`, 'bash', ['-c', script]);
	}

	/** Full clean: make mrproper on the selected build (removes .config and all output). */
	async mrproper(): Promise<number> {
		const settings = this.settings;
		const state = settings.configured();
		const makeArgs = state ? settings.makeArgs(state) : settings.makeArgsForConfigure();
		const name = `Full clean ${settings.arch} ${settings.variant}`;
		const code = await runTask(this.folder, name, 'bash', [
			'-c',
			this.make(makeArgs, 'mrproper'),
		]);
		if (code === 0) {
			settings.clearConfigured();
		}
		return code;
	}

	/**
	 * menuconfig / nconfig on the configured build, in a terminal in the editor area: they
	 * need at least 19 lines by 80 columns, more than the terminal panel often has.
	 */
	async interactiveConfig(tool: 'menuconfig' | 'nconfig'): Promise<void> {
		const state = this.settings.configured();
		if (!state) {
			vscode.window.showWarningMessage('Kernel: run Configure first.');
			return;
		}
		const make = this.make(this.settings.makeArgs(state), tool);
		const terminal = vscode.window.createTerminal({
			name: `${tool} ${state.arch} ${state.variant}`,
			location: vscode.TerminalLocation.Editor,
			cwd: this.root,
			shellPath: 'bash',
			// A clean exit closes the terminal; a failure stays to be read.
			shellArgs: [
				'-c',
				`${make} || { echo; read -n1 -p "${tool} failed. Press a key to close."; exit 1; }`,
			],
		});
		terminal.show();
	}

	/** Fails early, naming the packages to install, if build tools are missing. */
	checkTools(makeArgs: string[], arch: string): boolean {
		const missing = buildRequirements(makeArgs).filter(r => !r.present());
		if (!missing.length) {
			return true;
		}
		const command = installCommand(missing);
		vscode.window.showErrorMessage(
			`Kernel: cannot build ${arch}, missing ${describe(missing)}.` +
				(command ? ` Install with: ${command}` : ''),
		);
		return false;
	}

	/** The kernel image of a configured build. */
	image(state: Configured): string {
		return path.join(state.buildDir, archInfo(state.arch).image);
	}
}

/**
 * scripts/config arguments for options: name (without CONFIG_) -> "y", "n", "m", a number
 * or a string. A value that looks like a number is set as one, quoted or not.
 */
export function scriptsConfigArgs(options: Record<string, string>): string[] {
	const args: string[] = [];
	for (const [name, value] of Object.entries(options)) {
		if (value === 'y') {
			args.push('-e', name);
		} else if (value === 'n') {
			args.push('-d', name);
		} else if (value === 'm') {
			args.push('-m', name);
		} else if (/^-?(0x)?[0-9a-fA-F]+$/.test(value)) {
			args.push('--set-val', name, value);
		} else {
			args.push('--set-str', name, value.replace(/^"|"$/g, ''));
		}
	}
	return args;
}
