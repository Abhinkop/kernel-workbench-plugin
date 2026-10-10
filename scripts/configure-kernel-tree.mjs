// Saves the kernel tree used for developing this extension in the kernelWorkbench.dev.kernelTree
// setting of .vscode/settings.json, which "Run Extension" and the integration tests read.
// Run it with the "Configure kernel tree" task, or: node scripts/configure-kernel-tree.mjs <dir>
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { applyEdits, modify } from 'jsonc-parser';

const [arg] = process.argv.slice(2);
if (!arg) {
	console.error('Usage: node scripts/configure-kernel-tree.mjs <path to a Linux kernel clone>');
	process.exit(1);
}

const kernelTree = resolve(arg.replace(/^~(?=\/|$)/, homedir()));
if (!existsSync(kernelTree) || !statSync(kernelTree).isDirectory()) {
	console.error(`${kernelTree} is not a folder.`);
	process.exit(1);
}

const settingsFile = new URL('../.vscode/settings.json', import.meta.url);
const settings = readFileSync(settingsFile, 'utf8');
const edits = modify(settings, ['kernelWorkbench.dev.kernelTree'], kernelTree, {
	formattingOptions: { insertSpaces: false, tabSize: 4 },
});
writeFileSync(settingsFile, applyEdits(settings, edits));
console.log(`kernelWorkbench.dev.kernelTree = ${kernelTree}`);
