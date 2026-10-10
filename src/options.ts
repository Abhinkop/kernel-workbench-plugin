import * as vscode from 'vscode';
import * as path from 'path';
import { archInfo, isNative } from './arch';
import type { Settings } from './settings';

/** How an option is shown and edited. */
export interface OptionSpec {
	/** kernelWorkbench.<key>, or $arch, $variant and $config for the target */
	key: string;
	label: string;
	kind:
		| 'enum'
		| 'bool'
		| 'string'
		| 'args'
		| 'words'
		| 'options'
		| 'int'
		| 'archString'
		| 'archFile';
	/** for 'enum' */
	choices?: { value: string; label: string }[];
	placeholder?: string;
}

/** The options the steps use, in the order the Kernel view lists them. */
export const OPTIONS: OptionSpec[] = [
	{
		key: 'toolchain',
		label: 'Toolchain',
		kind: 'enum',
		choices: [
			{ value: 'gcc', label: 'GCC' },
			{ value: 'llvm', label: 'LLVM (LLVM=1)' },
		],
	},
	{
		key: 'crossCompile',
		label: 'CROSS_COMPILE',
		kind: 'archString',
		placeholder: 'empty: the default for the architecture',
	},
	{ key: 'make.ccache', label: 'ccache', kind: 'bool' },
	{
		key: 'make.args',
		label: 'Extra make arguments',
		kind: 'args',
		placeholder: 'W=1 KCFLAGS=-Og',
	},
	{
		key: 'configure.fragments',
		label: 'Config fragments',
		kind: 'words',
		placeholder: 'kernel/configs/debug.config',
	},
	{
		key: 'configure.options',
		label: 'Config options',
		kind: 'options',
		placeholder: 'KASAN=y LOG_BUF_SHIFT=18',
	},
	{
		key: 'terminal.afterTask',
		label: 'When a step finishes',
		kind: 'enum',
		choices: [
			{ value: 'closeOnSuccess', label: 'Close the terminal if it succeeded' },
			{ value: 'keep', label: 'Keep the terminal open' },
		],
	},
	{
		key: 'run.mode',
		label: 'Boot with',
		kind: 'enum',
		choices: [
			{ value: 'qemu', label: 'QEMU' },
			{ value: 'virtme', label: 'virtme-ng' },
		],
	},
	{ key: 'run.initramfs', label: 'Initramfs', kind: 'archFile' },
	{ key: 'run.shareBuildDir', label: 'Share build directory with the guest', kind: 'bool' },
	{ key: 'run.cmdline', label: 'Kernel command line', kind: 'string', placeholder: 'loglevel=8' },
	{
		key: 'run.qemuArgs',
		label: 'Extra QEMU arguments',
		kind: 'args',
		placeholder: '-device virtio-rng-pci',
	},
	{ key: 'run.memory', label: 'Memory', kind: 'string', placeholder: '2G' },
	{ key: 'run.smp', label: 'CPUs', kind: 'int' },
];

/** An option's current value, as the Kernel view shows it. */
export function describeOption(settings: Settings, option: OptionSpec): string {
	const value = settings.get<any>(option.key, undefined);
	const arch = settings.arch;
	switch (option.kind) {
		case 'enum': {
			const choice =
				option.choices?.find(c => c.value === value) ??
				(option.key === 'terminal.afterTask' ? option.choices?.[0] : undefined);
			return choice?.label ?? String(value ?? '');
		}
		case 'bool':
			return value ? 'on' : 'off';
		case 'args':
			return joinArgs(value ?? []) || 'none';
		case 'words':
			return (value ?? []).join(' ') || 'none';
		case 'options': {
			const entries = Object.entries(value ?? {});
			return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(' ') : 'none';
		}
		case 'int':
			return String(value ?? '');
		case 'archString': {
			const prefix = (value ?? {})[arch];
			if (prefix) {
				return `${prefix} (${arch})`;
			}
			return `default (${arch}: ${isNative(arch) ? 'native' : archInfo(arch).gccPrefix})`;
		}
		case 'archFile': {
			const file = (value ?? {})[arch];
			return file ? `${path.basename(file)} (${arch})` : `none (${arch})`;
		}
		default:
			return String(value ?? '');
	}
}

/**
 * Changes an option, writing it where its current value comes from: the
 * workspace folder or workspace if set there, else the user settings.
 */
export async function editOption(settings: Settings, option: OptionSpec): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('kernelWorkbench', settings.folder.uri);
	const write = async (value: unknown) => {
		const info = cfg.inspect(option.key);
		const target =
			info?.workspaceFolderValue !== undefined
				? vscode.ConfigurationTarget.WorkspaceFolder
				: info?.workspaceValue !== undefined
					? vscode.ConfigurationTarget.Workspace
					: vscode.ConfigurationTarget.Global;
		await cfg.update(option.key, value, target);
	};
	const current = settings.get<any>(option.key, undefined);
	const ask = (value: string) =>
		vscode.window.showInputBox({
			title: option.label,
			value,
			placeHolder: option.placeholder,
			prompt: `kernelWorkbench.${option.key}`,
		});
	const arch = settings.arch;
	switch (option.kind) {
		case 'enum': {
			const pick = await vscode.window.showQuickPick(
				(option.choices ?? []).map(c => ({
					label: c.label,
					value: c.value,
					picked: c.value === current,
					description: c.value === current ? 'current' : '',
				})),
				{ title: option.label },
			);
			if (pick) {
				await write(pick.value);
			}
			return;
		}
		case 'bool':
			await write(!current);
			return;
		case 'int': {
			const value = await ask(String(current ?? ''));
			if (value !== undefined) {
				await write(Math.max(1, parseInt(value, 10) || 1));
			}
			return;
		}
		case 'string': {
			const value = await ask(current ?? '');
			if (value !== undefined) {
				await write(value);
			}
			return;
		}
		case 'args': {
			const value = await ask(joinArgs(current ?? []));
			if (value !== undefined) {
				await write(splitArgs(value));
			}
			return;
		}
		case 'words': {
			const value = await ask((current ?? []).join(' '));
			if (value !== undefined) {
				await write(value.split(/\s+/).filter(Boolean));
			}
			return;
		}
		case 'options': {
			const entries = Object.entries(current ?? {}).map(([k, v]) => `${k}=${v}`);
			const value = await ask(entries.join(' '));
			if (value === undefined) {
				return;
			}
			const options: Record<string, string> = {};
			for (const m of value.matchAll(/(?:CONFIG_)?(\w+)=("[^"]*"|\S+)/g)) {
				options[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
			}
			await write(options);
			return;
		}
		case 'archString': {
			const value = await ask((current ?? {})[arch] ?? '');
			if (value === undefined) {
				return;
			}
			const map: Record<string, string> = { ...(current ?? {}) };
			if (value.trim()) {
				map[arch] = value.trim();
			} else {
				delete map[arch];
			}
			await write(map);
			return;
		}
		case 'archFile': {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: '$(folder-opened) Choose a file…', value: 'browse' },
					{ label: '$(close) None: boot without an initramfs', value: 'none' },
				],
				{ title: `${option.label} for ${arch}` },
			);
			if (!pick) {
				return;
			}
			const map: Record<string, string> = { ...(current ?? {}) };
			if (pick.value === 'none') {
				delete map[arch];
			} else {
				const uri = await vscode.window.showOpenDialog({
					title: `${option.label} for ${arch}`,
					canSelectMany: false,
				});
				if (!uri) {
					return;
				}
				map[arch] = uri[0].fsPath;
			}
			await write(map);
			return;
		}
	}
}

/** Splits a command-line-like string, honouring '…' and "…". */
export function splitArgs(text: string): string[] {
	const out: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		out.push(
			m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3],
		);
	}
	return out;
}

/** Joins arguments for display, quoting the ones that need it. */
export function joinArgs(args: string[]): string {
	return args
		.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, '\\$1')}"`))
		.join(' ');
}
