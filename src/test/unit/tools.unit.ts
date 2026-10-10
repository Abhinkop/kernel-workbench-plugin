// What the host must provide for the selected toolchain, and how to say and install it.
import * as assert from 'node:assert/strict';
import { extensionContext, state, workspaceFolder } from '../helpers/vscode';
import { tempDir } from '../helpers/repo';
import { Settings } from '../../settings';
import { buildRequirements, describe as say, installCommand, missing, onPath } from '../../tools';

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

	it('finds programs on PATH', () => {
		assert.ok(onPath('sh'));
		assert.ok(!onPath('no-such-program-kwb'));
		assert.ok(onPath('/bin/sh'));
	});
});
