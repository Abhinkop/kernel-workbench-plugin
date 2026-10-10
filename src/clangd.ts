import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { archInfo } from './arch';
import type { Configured } from './settings';

// Flags from a GCC build that clang (and therefore clangd) rejects or treats differently.
const GCC_ONLY_FLAGS = [
	'-mpreferred-stack-boundary=*',
	'-mindirect-branch=*',
	'-mindirect-branch-register',
	'-mindirect-branch-cs-prefix',
	'-mfunction-return=*',
	'-mharden-sls=*',
	'-mrecord-mcount',
	'-mskip-rax-setup',
	'-mno-fp-ret-in-387',
	'-mstack-protector-guard*',
	'-mabi=lp64',
	'-fno-allow-store-data-races',
	'-fconserve-stack',
	'-fno-ipa-sra',
	'-fasan-shadow-offset=*',
	'-fmin-function-alignment=*',
	'-fzero-init-padding-bits=*',
	'-falign-jumps=*',
	'-falign-loops=*',
	'-fsanitize=bounds-strict',
	'-fno-var-tracking-assignments',
	'-fno-tree-*',
	'-fsched-pressure',
	'--param=*',
	// The build's -Werror is for gcc's warnings; clang warns differently and clangd
	// would show those as errors.
	'-Werror',
];
const GCC_ONLY = GCC_ONLY_FLAGS.map(f =>
	f.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\S*'),
).join('|');
const GCC_ONLY_IN_COMMAND = new RegExp(`(^|\\s)(${GCC_ONLY})(?=\\s|$)`, 'g');
const GCC_ONLY_ARG = new RegExp(`^(${GCC_ONLY})$`);

interface CompileCommand {
	command?: string;
	arguments?: string[];
}

/**
 * Puts the active build's compile_commands.json at the root of the tree, where
 * clangd looks by default (the kernel's .gitignore already ignores it). No
 * settings or .clangd files are written. For GCC builds the gcc-only flags are
 * stripped and the clang target is made explicit.
 */
export async function updateCompileCommands(root: string, state: Configured): Promise<void> {
	const enabled = vscode.workspace
		.getConfiguration('kernelWorkbench', vscode.Uri.file(root))
		.get('clangd.updateCompileCommands', true);
	if (!enabled) {
		return;
	}
	const source = path.join(state.buildDir, 'compile_commands.json');
	if (!fs.existsSync(source)) {
		return;
	}
	const db: CompileCommand[] = JSON.parse(fs.readFileSync(source, 'utf8'));
	if (!state.makeArgs.includes('LLVM=1')) {
		const extra = ` -Wno-unknown-warning-option --target=${archInfo(state.arch).clangTarget}`;
		for (const entry of db) {
			if (entry.command) {
				entry.command = entry.command.replace(GCC_ONLY_IN_COMMAND, '') + extra;
			} else if (entry.arguments) {
				entry.arguments = entry.arguments
					.filter(a => !GCC_ONLY_ARG.test(a))
					.concat(extra.trim().split(' '));
			}
		}
	}
	fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(db, null, 1));

	if (vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd')) {
		await vscode.commands.executeCommand('clangd.restart').then(undefined, () => undefined);
	}
}

/** Switching arch or variant: points clangd at that build, if it exists. */
export async function followSelection(root: string, state: Configured | undefined): Promise<void> {
	if (state) {
		await updateCompileCommands(root, state);
	}
}
