// What the host must provide for the selected toolchain, and how to say and install it.
import * as assert from 'node:assert/strict';
import { extensionContext, state, workspaceFolder } from '../helpers/vscode';
import { tempDir } from '../helpers/repo';
import { Settings } from '../../settings';
import { ARCHES, archInfo, isNative } from '../../arch';
import {
	aptKnows,
	buildRequirements,
	describe as say,
	installCommand,
	missing,
	onPath,
	qemuPackage,
	requirements,
} from '../../tools';

describe('tools', () => {
	const names = (makeArgs: string[]) => buildRequirements(makeArgs).map(r => r.what);

	it('needs the compiler of the toolchain, and the host compiler for scripts/', () => {
		assert.ok(names(['CROSS_COMPILE=']).includes('gcc'));
		assert.ok(names(['CROSS_COMPILE=aarch64-linux-gnu-']).includes('aarch64-linux-gnu-gcc'));
		assert.ok(names(['CROSS_COMPILE=aarch64-linux-gnu-']).includes('gcc'));
		const llvm = names(['LLVM=1', 'CROSS_COMPILE=']);
		assert.ok(['clang', 'ld.lld', 'llvm-ar'].every(t => llvm.includes(t)));
		assert.ok(!llvm.includes('gcc'));
		assert.ok(names(['CROSS_COMPILE=', 'CC=ccache gcc']).includes('ccache'));
		assert.ok(names([]).includes('libelf/gelf.h'));
	});

	it('names the packages, and builds one install command', () => {
		const reqs = [
			{ step: 'build' as const, what: 'flex', pkg: 'flex', present: () => false },
			{ step: 'build' as const, what: 'bison', pkg: 'bison', present: () => false },
			{
				step: 'build' as const,
				what: 'a header',
				hint: 'see the docs',
				present: () => false,
			},
		];
		assert.equal(say(reqs), 'build: flex, bison, a header (see the docs)');
		assert.equal(
			installCommand(reqs),
			onPath('apt-get') ? 'sudo apt-get install flex bison' : '',
		);
		assert.equal(installCommand([reqs[2]]), '', 'nothing to install');
	});

	it('checks the recorded make arguments, or the ones the next Configure would use', () => {
		const settings = new Settings(extensionContext(), workspaceFolder(tempDir()));
		state.config['kernelWorkbench.crossCompile'] = {
			x86_64: 'no-such-',
			arm64: 'no-such-',
			riscv64: 'no-such-',
		};
		assert.ok(missing(settings).some(r => r.what === 'no-such-gcc'));
		settings.saveConfigured({
			arch: settings.arch,
			variant: 'debug',
			config: 'defconfig',
			buildDir: settings.buildDir(),
			makeArgs: ['O=x', 'ARCH=x86_64', 'CROSS_COMPILE=recorded-'],
			configuredAt: 'now',
		});
		assert.ok(missing(settings).some(r => r.what === 'recorded-gcc'));
		assert.ok(!missing(settings).some(r => r.what === 'no-such-gcc'));
	});

	it('names the QEMU package for each architecture and distro', () => {
		aptKnows.set('qemu-system-riscv', true);
		assert.equal(
			qemuPackage('riscv64'),
			'qemu-system-riscv',
			'split out since QEMU 10 packaging',
		);
		aptKnows.set('qemu-system-riscv', false);
		assert.equal(qemuPackage('riscv64'), 'qemu-system-misc', 'older Debian/Ubuntu');
		aptKnows.clear();
		assert.equal(qemuPackage('arm64'), 'qemu-system-arm');
		assert.equal(qemuPackage('x86_64'), 'qemu-system-x86');
	});

	it('covers run and debug: QEMU or vng, the initramfs, gdb', () => {
		const settings = new Settings(extensionContext(), workspaceFolder(tempDir()));
		let what = requirements(settings).map(r => r.what);
		assert.ok(what.includes(archInfo(settings.arch).qemu));
		assert.ok(what.includes(settings.gdbPath()));
		assert.ok(!what.includes('vng'));
		state.config['kernelWorkbench.run.mode'] = 'virtme';
		what = requirements(settings).map(r => r.what);
		assert.ok(what.includes('vng') && !what.includes(archInfo(settings.arch).qemu));
		state.config['kernelWorkbench.run.mode'] = 'qemu';
		state.config['kernelWorkbench.run.initramfs'] = { [settings.arch]: '/no/such/file' };
		assert.ok(missing(settings).some(r => r.what === 'initramfs /no/such/file'));
		const cross = Object.keys(ARCHES).find(a => !isNative(a))!;
		state.config['kernelWorkbench.arch'] = cross;
		assert.ok(requirements(settings).some(r => r.what === 'gdb-multiarch'));
	});

	it('finds programs on PATH', () => {
		assert.ok(onPath('sh'));
		assert.ok(!onPath('no-such-program-kwb'));
		assert.ok(onPath('/bin/sh'));
	});
});
