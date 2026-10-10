import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { archInfo } from './arch';
import type { Settings } from './settings';
import { runTask, sq } from './tasks';

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
