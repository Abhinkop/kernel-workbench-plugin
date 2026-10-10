// Picking the build target from the Command Palette: the choices offered
// and what a pick changes.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { answer, extensionContext, vscode, workspaceFolder } from '../helpers/vscode';
import { tempDir } from '../helpers/repo';
import { Settings } from '../../settings';
import { listConfigs, pickArch, pickConfig, pickVariant } from '../../ui';

describe('picking the build target', () => {
	/** A tree with arm64 configs, arm64 selected. */
	async function tree() {
		const root = tempDir();
		const dir = path.join(root, 'arch', 'arm64', 'configs');
		fs.mkdirSync(dir, { recursive: true });
		for (const f of ['virt_defconfig', 'defconfig', 'hardening.config']) {
			fs.writeFileSync(path.join(dir, f), '');
		}
		const s = new Settings(extensionContext(), workspaceFolder(root));
		await s.select('arch', 'arm64');
		return s;
	}

	it('offers the generic targets and the arch _defconfigs as base configs', async () => {
		const s = await tree();
		assert.deepEqual(
			listConfigs(s).map(c => c.value),
			['defconfig', 'virt_defconfig', 'tinyconfig', 'allnoconfig'],
		);
	});

	it('lists a base config that is not in the list first, marked current', async () => {
		const s = await tree();
		await s.select('config', '/home/me/my.config');
		assert.deepEqual(listConfigs(s)[0], {
			value: '/home/me/my.config',
			description: 'current',
		});
	});

	it('Select Architecture offers every arch, marks the current one, and picks', async () => {
		const s = await tree();
		let offered: any[] = [];
		answer((items: any[]) => ((offered = items), items.find(i => i.label === 'riscv64')));
		await pickArch(s);
		assert.deepEqual(
			offered.map(i => i.label),
			['x86_64', 'arm64', 'riscv64'],
		);
		assert.match(offered[1].description, /· current$/);
		assert.equal(s.arch, 'riscv64');
	});

	it('Select Debug / Release picks the variant', async () => {
		const s = await tree();
		answer((items: any[]) => items.find(i => i.label === 'Release'));
		await pickVariant(s);
		assert.equal(s.variant, 'release');
	});

	it('Select Base Config picks a listed config, or a .config file', async () => {
		const s = await tree();
		answer((items: any[]) => items.find(i => i.label === 'virt_defconfig'));
		await pickConfig(s);
		assert.equal(s.config, 'virt_defconfig');

		// The last entry browses for a file; the open dialog then answers with it.
		answer((items: any[]) => items[items.length - 1], [vscode.Uri.file('/home/me/my.config')]);
		await pickConfig(s);
		assert.equal(s.config, '/home/me/my.config');
	});

	it('Escape changes nothing', async () => {
		const s = await tree();
		await pickArch(s);
		await pickVariant(s);
		await pickConfig(s);
		assert.deepEqual([s.arch, s.variant, s.config], ['arm64', 'debug', 'defconfig']);
	});
});
