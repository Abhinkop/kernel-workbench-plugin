// The target selection: architecture, build variant and base config, and
// the build directory that follows from them.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { tempDir } from '../helpers/repo';
import { ARCHES, archInfo, isNative } from '../../arch';
import { Settings } from '../../settings';

const ROOT = '/src/linux';
const hostArch = Object.keys(ARCHES).find(isNative) ?? 'x86_64';

/** Set kernelWorkbench.* settings, by key without the prefix. */
function configure(values: Record<string, unknown>) {
	for (const [key, value] of Object.entries(values)) {
		state.config[`kernelWorkbench.${key}`] = value;
	}
}

describe('architectures', () => {
	it('archInfo knows the supported architectures and rejects others', () => {
		assert.deepEqual(Object.keys(ARCHES), ['x86_64', 'arm64', 'riscv64']);
		assert.equal(archInfo('riscv64').kernelArch, 'riscv');
		assert.throws(() => archInfo('mips'), /Unsupported architecture "mips"/);
	});

	it('isNative compares with the host machine', () => {
		for (const a of Object.keys(ARCHES)) {
			assert.equal(isNative(a), archInfo(a).hostUname === os.machine());
		}
	});
});

describe('the build target', () => {
	const settings = () => new Settings(extensionContext(), workspaceFolder(ROOT));

	it('with nothing picked or set: the host arch, Debug, defconfig', () => {
		const s = settings();
		assert.equal(s.arch, hostArch);
		assert.equal(s.variant, 'debug');
		assert.equal(s.config, 'defconfig');
		assert.equal(s.buildDir(), path.join(ROOT, 'build', hostArch, 'debug'));
	});

	it('settings give the defaults; a pick in the tree overrides them', async () => {
		configure({ arch: 'riscv64', variant: 'release', 'configure.defconfig': 'tinyconfig' });
		const s = settings();
		assert.deepEqual([s.arch, s.variant, s.config], ['riscv64', 'release', 'tinyconfig']);
		await s.select('arch', 'arm64');
		await s.select('variant', 'debug');
		assert.deepEqual([s.arch, s.variant, s.config], ['arm64', 'debug', 'tinyconfig']);
	});

	it('an unknown arch or variant falls back to x86_64 and Debug', () => {
		configure({ arch: 'mips', variant: 'fast' });
		const s = settings();
		assert.equal(s.arch, 'x86_64');
		assert.equal(s.variant, 'debug');
	});

	it('the base config is picked per arch', async () => {
		const s = settings();
		await s.select('arch', 'arm64');
		await s.select('config', 'tinyconfig');
		await s.select('arch', 'x86_64');
		assert.equal(s.config, 'defconfig');
		await s.select('arch', 'arm64');
		assert.equal(s.config, 'tinyconfig');
	});

	it('the build directory substitutes ${arch} and ${variant}', () => {
		const s = settings();
		configure({ buildDirectory: 'out/${variant}-${arch}' });
		assert.equal(s.buildDir('arm64', 'release'), path.join(ROOT, 'out', 'release-arm64'));
		configure({ buildDirectory: '/tmp/kbuild/${arch}' });
		assert.equal(s.buildDir('riscv64', 'debug'), '/tmp/kbuild/riscv64');
	});

	it('onDidChange fires for a pick and for a kernelWorkbench setting', async () => {
		const s = settings();
		let fired = 0;
		s.onDidChange(() => fired++);
		await s.select('variant', 'release');
		await vscode.workspace.getConfiguration('kernelWorkbench').update('buildDirectory', 'out');
		assert.equal(fired, 2);
	});
});

describe('the make arguments and the recorded configure state', () => {
	const settings = () => new Settings(extensionContext(), workspaceFolder(ROOT));
	const cross = isNative('arm64') ? 'riscv64' : 'arm64';

	it('builds the make arguments for GCC, cross GCC, LLVM and ccache', async () => {
		const s = settings();
		await s.select('arch', cross);
		let args = s.makeArgsForConfigure();
		assert.equal(args[0], `O=${path.join(ROOT, 'build', cross, 'debug')}`);
		assert.ok(args.includes(`ARCH=${archInfo(cross).kernelArch}`));
		assert.ok(args.includes(`CROSS_COMPILE=${archInfo(cross).gccPrefix}`));

		configure({ crossCompile: { [cross]: 'my-prefix-' }, 'make.ccache': true });
		args = s.makeArgsForConfigure();
		assert.ok(args.includes('CROSS_COMPILE=my-prefix-'));
		assert.ok(args.includes('CC=ccache my-prefix-gcc'));

		configure({ toolchain: 'llvm', 'make.args': ['W=1'] });
		assert.deepEqual(s.makeArgsForConfigure().slice(2), [
			'LLVM=1',
			'CROSS_COMPILE=',
			'CC=ccache clang',
			'W=1',
		]);
	});

	it('uses no CROSS_COMPILE prefix for the host architecture', async () => {
		const s = settings();
		await s.select('arch', hostArch);
		assert.ok(s.makeArgsForConfigure().includes('CROSS_COMPILE='));
	});

	it('uses all CPUs unless make.jobs is set', () => {
		const s = settings();
		assert.equal(s.jobs(), `-j${os.cpus().length}`);
		configure({ 'make.jobs': 3 });
		assert.equal(s.jobs(), '-j3');
	});

	it('records and reads back what Configure used, in the build directory', () => {
		const s = new Settings(extensionContext(), workspaceFolder(tempDir()));
		assert.equal(s.configured(), undefined);
		let fired = 0;
		s.onDidChange(() => fired++);
		const recorded = {
			arch: s.arch,
			variant: 'debug' as const,
			config: 'defconfig',
			buildDir: s.buildDir(),
			makeArgs: ['O=x'],
			configuredAt: 'now',
		};
		s.saveConfigured(recorded);
		assert.deepEqual(s.configured(), recorded);
		assert.ok(fs.existsSync(path.join(s.buildDir(), '.kernel-workbench.json')));
		s.clearConfigured();
		assert.equal(s.configured(), undefined);
		assert.equal(fired, 2, 'the view re-renders on both');
	});
});
