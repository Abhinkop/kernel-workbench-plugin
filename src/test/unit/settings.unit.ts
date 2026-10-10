// The target selection: architecture, build variant and base config, and
// the build directory that follows from them.
import { stub, fakeContext, folder } from './vscodeStub';
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { ARCHES, archInfo, isNative } from '../../arch';
import { Settings } from '../../settings';

const ROOT = '/src/linux';
const hostArch = Object.keys(ARCHES).find(isNative) ?? 'x86_64';

beforeEach(() => {
	stub.settings = {};
});

test('archInfo knows the supported architectures and rejects others', () => {
	assert.deepEqual(Object.keys(ARCHES), ['x86_64', 'arm64', 'riscv64']);
	assert.equal(archInfo('riscv64').kernelArch, 'riscv');
	assert.throws(() => archInfo('mips'), /Unsupported architecture "mips"/);
});

test('isNative compares with the host machine', () => {
	for (const a of Object.keys(ARCHES)) {
		assert.equal(isNative(a), archInfo(a).hostUname === os.machine());
	}
});

test('with nothing picked or set: the host arch, Debug, defconfig', () => {
	const s = new Settings(fakeContext(), folder(ROOT));
	assert.equal(s.arch, hostArch);
	assert.equal(s.variant, 'debug');
	assert.equal(s.config, 'defconfig');
	assert.equal(s.buildDir(), path.join(ROOT, 'build', hostArch, 'debug'));
});

test('settings give the defaults; a pick in the tree overrides them', async () => {
	stub.settings = { arch: 'riscv64', variant: 'release', 'configure.defconfig': 'tinyconfig' };
	const s = new Settings(fakeContext(), folder(ROOT));
	assert.deepEqual([s.arch, s.variant, s.config], ['riscv64', 'release', 'tinyconfig']);
	await s.select('arch', 'arm64');
	await s.select('variant', 'debug');
	assert.deepEqual([s.arch, s.variant, s.config], ['arm64', 'debug', 'tinyconfig']);
});

test('an unknown arch or variant falls back to x86_64 and Debug', async () => {
	stub.settings = { arch: 'mips', variant: 'fast' };
	const s = new Settings(fakeContext(), folder(ROOT));
	assert.equal(s.arch, 'x86_64');
	assert.equal(s.variant, 'debug');
});

test('the base config is picked per arch', async () => {
	const s = new Settings(fakeContext(), folder(ROOT));
	await s.select('arch', 'arm64');
	await s.select('config', 'tinyconfig');
	await s.select('arch', 'x86_64');
	assert.equal(s.config, 'defconfig');
	await s.select('arch', 'arm64');
	assert.equal(s.config, 'tinyconfig');
});

test('the build directory substitutes ${arch} and ${variant}', () => {
	const s = new Settings(fakeContext(), folder(ROOT));
	stub.settings = { buildDirectory: 'out/${variant}-${arch}' };
	assert.equal(s.buildDir('arm64', 'release'), path.join(ROOT, 'out', 'release-arm64'));
	stub.settings = { buildDirectory: '/tmp/kbuild/${arch}' };
	assert.equal(s.buildDir('riscv64', 'debug'), '/tmp/kbuild/riscv64');
});

test('onDidChange fires for a pick and for a kernelWorkbench setting', async () => {
	const s = new Settings(fakeContext(), folder(ROOT));
	let fired = 0;
	s.onDidChange(() => fired++);
	await s.select('variant', 'release');
	stub.changeSettings({ buildDirectory: 'out' });
	assert.equal(fired, 2);
});
