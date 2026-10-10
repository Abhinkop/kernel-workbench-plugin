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
		const kbuild = new Kbuild(settings);
		kbuild.checkTools = () => true; // the host's tools are not the point here
		return {
			root,
			settings,
			kbuild,
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

	it('builds with the recorded toolchain and the extra arguments as set now', async () => {
		const { settings, kbuild, log } = fake();
		state.config['kernelWorkbench.make.args'] = ['KCFLAGS=-Og'];
		await kbuild.configure();
		state.config['kernelWorkbench.make.args'] = ['W=1']; // changed after Configure
		state.config['kernelWorkbench.toolchain'] = 'llvm'; // needs a new Configure: not used
		assert.equal(await kbuild.build(), 0);
		const builds = log()
			.split('\n')
			.filter(l => /^make /.test(l) && !/defconfig/.test(l));
		assert.equal(builds.length, 2, log());
		assert.match(builds[1], / compile_commands\.json$/, 'the database for clangd');
		assert.ok(
			builds.every(l => / W=1 /.test(l)),
			'the extra arguments as set now',
		);
		assert.ok(builds.every(l => !/KCFLAGS/.test(l)));
		assert.ok(
			builds.every(l => /CROSS_COMPILE=/.test(l)),
			'the toolchain the .config was made with',
		);
		assert.ok(builds.every(l => !/LLVM=1/.test(l)));
		assert.deepEqual(settings.makeArgs(settings.configured()!).slice(-1), ['W=1']);
	});

	it('configures first when nothing is configured yet', async () => {
		const { settings, kbuild, log } = fake();
		assert.equal(settings.configured(), undefined);
		assert.equal(await kbuild.build(), 0);
		const makes = log()
			.split('\n')
			.filter(l => /^make /.test(l));
		assert.match(makes[0], /defconfig/);
		assert.ok(
			makes.slice(1).some(l => /-j\d+$/.test(l)),
			'then the build',
		);
		assert.ok(settings.configured());
	});

	it('keeps the terminal of a build that failed', async () => {
		const { settings, kbuild } = fake();
		await kbuild.configure();
		state.config['kernelWorkbench.make.args'] = ['kwb-fail'];
		assert.notEqual(await kbuild.build(), 0);
		assert.deepEqual(
			vscode.window.terminals.map(t => t.name),
			[`Build ${settings.arch} debug`],
		);
	});

	it('cleans, and full-cleans forgetting the configuration', async () => {
		const { settings, kbuild, log } = fake();
		assert.equal(await kbuild.clean(), 0, 'nothing to clean before Configure');
		assert.doesNotMatch(log(), /clean/);
		await kbuild.configure();
		assert.equal(await kbuild.clean(), 0);
		assert.match(log(), /^make .* clean$/m);
		assert.equal(await kbuild.mrproper(), 0);
		assert.match(log(), /^make .* mrproper$/m);
		assert.equal(settings.configured(), undefined, 'Full clean forgets the configuration');
	});

	it('opens menuconfig in an editor tab, closing on a clean exit', async () => {
		const { kbuild } = fake();
		await kbuild.interactiveConfig('menuconfig');
		assert.match(String(state.log.pop()?.message), /run Configure first/);
		await kbuild.configure();
		await kbuild.interactiveConfig('menuconfig');
		const terminal = state.terminals.find(t => /^menuconfig /.test(t.name));
		assert.ok(terminal, 'a menuconfig terminal');
		assert.equal(terminal.options.location, vscode.TerminalLocation.Editor, 'room for 19x80');
		assert.ok(terminal.shown);
		const [, script] = terminal.options.shellArgs as string[];
		assert.match(
			script,
			/make .* menuconfig \|\| \{ .*read -n1.*exit 1; \}$/,
			'waits for a key only on failure',
		);
	});

	it('refuses to build when tools are missing, naming them', () => {
		const { settings } = fake();
		const kbuild = new Kbuild(settings);
		assert.equal(kbuild.checkTools(['CROSS_COMPILE=no-such-prefix-'], 'arm64'), false);
		assert.match(String(state.log.pop()?.message), /missing build: no-such-prefix-gcc/);
	});

	it('knows the kernel image of a build', () => {
		const { kbuild } = fake();
		const recorded = { arch: 'arm64', buildDir: '/b' } as any;
		assert.equal(kbuild.image(recorded), '/b/arch/arm64/boot/Image');
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
