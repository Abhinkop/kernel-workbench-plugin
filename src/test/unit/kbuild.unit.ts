// Configure: the base config, fragments and options applied through make,
// merge_config.sh and scripts/config, and the make arguments recorded for Build.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { kernelTree } from '../helpers/repo';
import { Kbuild, scriptsConfigArgs } from '../../kbuild';
import { Settings } from '../../settings';

describe('kbuild', () => {
	let savedPath: string | undefined;
	beforeEach(() => (savedPath = process.env.PATH));
	afterEach(() => (process.env.PATH = savedPath));

	/**
	 * A Kbuild over a fake tree whose make, scripts/config and merge_config.sh only log
	 * what they are asked; make fails on a target named kwb-fail.
	 */
	function fake() {
		const root = kernelTree();
		const bin = path.join(root, '.bin');
		fs.mkdirSync(bin);
		const log = path.join(root, 'make.log');
		const script = (file: string, lines: string[]) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `#!/bin/sh\n${lines.join('\n')}\n`, { mode: 0o755 });
		};
		script(path.join(bin, 'make'), [
			`echo "make $*" >> ${log}`,
			'case "$*" in *kwb-fail*) exit 1;; esac',
			'for a; do case $a in O=*) mkdir -p "${a#O=}"; touch "${a#O=}/.config";; esac; done',
		]);
		script(path.join(root, 'scripts', 'config'), [
			`echo "config $*" >> ${log}`,
			'[ "$3" = "-s" ] && echo y',
			'exit 0',
		]);
		script(path.join(root, 'scripts', 'kconfig', 'merge_config.sh'), [
			`echo "merge_config $*" >> ${log}`,
		]);
		process.env.PATH = `${bin}:${process.env.PATH}`;
		const settings = new Settings(extensionContext(), workspaceFolder(root));
		return {
			root,
			settings,
			kbuild: new Kbuild(settings),
			log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
		};
	}

	it('configures: base config, options, olddefconfig, and records the arguments', async () => {
		const { settings, kbuild, log } = fake();
		state.config['kernelWorkbench.configure.options'] = {
			KASAN: 'y',
			LOG_BUF_SHIFT: '18',
			LOCALVERSION: '-test',
		};
		assert.equal(await kbuild.configure(), 0);
		const l = log();
		assert.match(l, /make O=\S+ ARCH=\S+ .*defconfig/);
		assert.match(l, /config --file \S+\.config .*-e DEBUG_KERNEL .*-e GDB_SCRIPTS .*-e KASAN /);
		assert.match(l, /-e KASAN --set-val LOG_BUF_SHIFT 18 --set-str LOCALVERSION -test/);
		assert.match(l, /olddefconfig/);
		const recorded = settings.configured();
		assert.equal(recorded?.config, 'defconfig');
		assert.equal(recorded?.variant, 'debug');
		assert.ok(recorded?.makeArgs[0].startsWith('O='));
		assert.equal(vscode.window.terminals.length, 0, 'the terminal closed on success');
	});

	it('uses the Release options and a .config file as the base', async () => {
		const { settings, kbuild, log, root } = fake();
		await settings.select('variant', 'release');
		fs.writeFileSync(path.join(root, 'my.config'), 'CONFIG_X=y\n');
		await settings.select('config', 'my.config');
		assert.equal(await kbuild.configure(), 0);
		assert.match(log(), /-e DEBUG_INFO_NONE/);
		assert.doesNotMatch(log().split('\n')[0], /defconfig/, 'copies the file instead');
		assert.ok(fs.existsSync(path.join(settings.buildDir(), '.config')));
	});

	it('merges config fragments after the base config', async () => {
		const { kbuild, log, root } = fake();
		state.config['kernelWorkbench.configure.fragments'] = ['kernel/configs/debug.config'];
		assert.equal(await kbuild.configure(), 0);
		const lines = log().split('\n');
		const merge = lines.findIndex(l => /^merge_config -m -O \S+ \S+\.config /.test(l));
		assert.ok(merge > 0, log());
		assert.match(lines[merge], new RegExp(`${root}/kernel/configs/debug.config$`));
		assert.match(lines[merge - 1], /defconfig/, 'after the base config');
	});

	it('records nothing when configure fails, and keeps its terminal', async () => {
		const { settings, kbuild } = fake();
		await settings.select('config', 'kwb-fail');
		assert.notEqual(await kbuild.configure(), 0);
		assert.equal(settings.configured(), undefined);
		assert.deepEqual(
			vscode.window.terminals.map(t => t.name),
			[`Configure ${settings.arch} debug`],
		);
	});

	it('translates options into scripts/config arguments', () => {
		assert.deepEqual(
			scriptsConfigArgs({
				A: 'y',
				B: 'n',
				C: 'm',
				D: '0x10',
				E: '-1',
				F: '"text"',
				G: 'text',
			}),
			[
				'-e',
				'A',
				'-d',
				'B',
				'-m',
				'C',
				'--set-val',
				'D',
				'0x10',
				'--set-val',
				'E',
				'-1',
				'--set-str',
				'F',
				'text',
				'--set-str',
				'G',
				'text',
			],
		);
	});
});
