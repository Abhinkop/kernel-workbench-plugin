import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'url';

// The tests wait for activation, longer than mocha's 2 s default allows.
const mocha = { timeout: 20000 };

const fixture = name => fileURLToPath(new URL(`./test-fixtures/${name}`, import.meta.url));

export default defineConfig([
	{
		label: 'kernel-tree',
		files: 'out/test/activation/kernelTree.test.js',
		workspaceFolder: fixture('kernel-tree'),
		mocha,
	},
	{
		label: 'plain-folder',
		files: 'out/test/activation/plainFolder.test.js',
		workspaceFolder: fixture('plain-folder'),
		mocha,
	},
]);
