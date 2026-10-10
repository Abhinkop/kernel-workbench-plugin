// Picking the build target from the Command Palette: the choices offered
// and what a pick changes.
import { stub, fakeContext, folder } from './vscodeStub';
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Settings } from '../../settings';
import { listConfigs, pickArch, pickConfig, pickVariant } from '../../ui';

/** A tree with arm64 configs, arm64 selected. */
async function tree() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-workbench-target-'));
	const dir = path.join(root, 'arch', 'arm64', 'configs');
	fs.mkdirSync(dir, { recursive: true });
	for (const f of ['virt_defconfig', 'defconfig', 'hardening.config']) {
		fs.writeFileSync(path.join(dir, f), '');
	}
	const s = new Settings(fakeContext(), folder(root));
	await s.select('arch', 'arm64');
	return s;
}

beforeEach(() => {
	stub.settings = {};
	stub.quickPick = () => undefined;
	stub.openDialog = () => undefined;
});

test('the configs offered are the generic targets and the arch _defconfigs', async () => {
	const s = await tree();
	assert.deepEqual(
		listConfigs(s).map(c => c.value),
		['defconfig', 'virt_defconfig', 'tinyconfig', 'allnoconfig'],
	);
});

test('a base config that is not in the list comes first, marked current', async () => {
	const s = await tree();
	await s.select('config', '/home/me/my.config');
	assert.deepEqual(listConfigs(s)[0], { value: '/home/me/my.config', description: 'current' });
});

test('Select Architecture offers every arch, marks the current one, and picks', async () => {
	const s = await tree();
	let offered: any[] = [];
	stub.quickPick = items => ((offered = items), items.find(i => i.label === 'riscv64'));
	await pickArch(s);
	assert.deepEqual(
		offered.map(i => i.label),
		['x86_64', 'arm64', 'riscv64'],
	);
	assert.match(offered[1].description, /· current$/);
	assert.equal(s.arch, 'riscv64');
});

test('Select Debug / Release picks the variant', async () => {
	const s = await tree();
	stub.quickPick = items => items.find(i => i.label === 'Release');
	await pickVariant(s);
	assert.equal(s.variant, 'release');
});

test('Select Base Config picks a listed config, or a .config file', async () => {
	const s = await tree();
	stub.quickPick = items => items.find(i => i.label === 'virt_defconfig');
	await pickConfig(s);
	assert.equal(s.config, 'virt_defconfig');

	stub.quickPick = items => items[items.length - 1]; // Existing .config file…
	stub.openDialog = () => ['/home/me/my.config'];
	await pickConfig(s);
	assert.equal(s.config, '/home/me/my.config');
});

test('Escape changes nothing', async () => {
	const s = await tree();
	await pickArch(s);
	await pickVariant(s);
	await pickConfig(s);
	assert.deepEqual([s.arch, s.variant, s.config], ['arm64', 'debug', 'defconfig']);
});
