import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'url';

// describe/it as in the unit tests; the tests wait for activation, longer than mocha's 2 s
// default allows.
const mocha = { ui: 'bdd', timeout: 20000 };

const fixture = name => fileURLToPath(new URL(`./test-fixtures/${name}`, import.meta.url));

// A real kernel clone, for the integration tests (npm run test:integration): the activation
// test again, and src/test/integration/*.test.ts, inside VS Code with the clone open.
const kernelTree = process.env.KERNEL_TREE;

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
	...(kernelTree
		? [
				{
					label: 'integration',
					files: [
						'out/test/activation/kernelTree.test.js',
						'out/test/integration/*.test.js',
					],
					workspaceFolder: kernelTree,
					mocha,
				},
			]
		: []),
]);
