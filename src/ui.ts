import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ARCHES, archInfo, isNative } from './arch';
import type { Runner } from './runner';
import type { Settings } from './settings';

/** Mirrors the VM state into a context key, so Stop shows only while a VM runs. */
function syncContextKeys(context: vscode.ExtensionContext, runner: Runner): void {
	const update = () =>
		vscode.commands.executeCommand('setContext', 'kernelWorkbench.vmRunning', runner.running);
	context.subscriptions.push(
		runner.onDidChange(update),
		vscode.window.onDidOpenTerminal(update),
		vscode.window.onDidCloseTerminal(update),
	);
	update();
}

/**
 * Base configs offered for the current arch.
 */
function listConfigs(s: Settings): { value: string; description: string }[] {
	const karch = archInfo(s.arch).kernelArch;
	let archConfigs: string[] = [];
	try {
		archConfigs = fs
			.readdirSync(path.join(s.root, 'arch', karch, 'configs'))
			.filter(f => f.endsWith('_defconfig'))
			.sort();
	} catch {}
	const list = [
		{ value: 'defconfig', description: 'architecture default' },
		...archConfigs.map(c => ({ value: c, description: `arch/${karch}/configs` })),
		{ value: 'tinyconfig', description: 'smallest kernel' },
		{ value: 'allnoconfig', description: '' },
	];
	if (!list.some(c => c.value === s.config)) {
		list.unshift({ value: s.config, description: 'current' });
	}
	return list;
}

async function pickArch(s: Settings) {
	const pick = await vscode.window.showQuickPick(
		Object.keys(ARCHES).map(a => ({
			label: a,
			description: (isNative(a) ? 'native' : 'cross') + (a === s.arch ? ' · current' : ''),
		})),
		{ title: 'Kernel architecture' },
	);
	if (pick) {
		await s.select('arch', pick.label);
	}
}

async function pickVariant(s: Settings) {
	const pick = await vscode.window.showQuickPick(
		[
			{ label: 'Debug', description: 'debug info, gdb scripts', value: 'debug' },
			{ label: 'Release', description: 'no debug info', value: 'release' },
		],
		{ title: 'Build variant' },
	);
	if (pick) {
		await s.select('variant', pick.value);
	}
}

async function pickConfig(s: Settings) {
	const browse = '$(folder-opened) Existing .config file…';
	const pick = await vscode.window.showQuickPick(
		[
			...listConfigs(s).map(c => ({ label: c.value, description: c.description })),
			{ label: browse, description: '' },
		],
		{ title: `Base config for ${s.arch}`, matchOnDescription: true },
	);
	if (!pick) {
		return;
	}
	await setConfig(s, pick.label === browse ? undefined : pick.label);
}

/** @param value undefined: ask for a file */
async function setConfig(s: Settings, value?: string) {
	if (value === undefined) {
		const uri = await vscode.window.showOpenDialog({
			title: 'Base .config',
			canSelectMany: false,
		});
		if (!uri) {
			return;
		}
		value = uri[0].fsPath;
	}
	await s.select('config', value);
}

export { listConfigs, pickArch, pickVariant, pickConfig, setConfig, syncContextKeys };
