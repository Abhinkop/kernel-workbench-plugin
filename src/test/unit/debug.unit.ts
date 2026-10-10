// Debugging the kernel in QEMU: the gdbstub boot, the debugger front ends and their
// configurations, the hand-over once the guest is at the symbol, and the Release warning.
import * as assert from 'node:assert/strict';
import * as net from 'net';
import * as path from 'path';
import { answer, extensionContext, state, workspaceFolder } from '../helpers/vscode';
import { tempDir } from '../helpers/repo';
import { ARCHES, isNative } from '../../arch';
import { Kbuild } from '../../kbuild';
import { Runner } from '../../runner';
import { Settings } from '../../settings';
import type { Configured } from '../../settings';

describe('debug', () => {
	function fixture(root = tempDir()) {
		const settings = new Settings(extensionContext(), workspaceFolder(root));
		const kbuild = new Kbuild(settings);
		return { settings, kbuild, runner: new Runner(extensionContext(), settings, kbuild) };
	}

	const configured = (arch: string, buildDir = tempDir()): Configured => ({
		arch,
		variant: 'debug',
		config: 'defconfig',
		buildDir,
		makeArgs: [`O=${buildDir}`, `ARCH=${arch}`, 'CROSS_COMPILE='],
		configuredAt: new Date().toISOString(),
	});

	it('picks gdb for the host architecture, gdb-multiarch otherwise, or the setting', async () => {
		const { settings } = fixture();
		const native = Object.keys(ARCHES).find(isNative);
		if (native) {
			await settings.select('arch', native);
			assert.equal(settings.gdbPath(), 'gdb');
		}
		await settings.select(
			'arch',
			Object.keys(ARCHES).find(a => !isNative(a))!,
		);
		assert.equal(settings.gdbPath(), 'gdb-multiarch');
		state.config['kernelWorkbench.debug.gdb'] = '/opt/gdb';
		assert.equal(settings.gdbPath(), '/opt/gdb');
	});

	it('boots halted with a gdbstub and nokaslr for a debug boot', () => {
		const { runner } = fixture();
		state.config['kernelWorkbench.debug.port'] = 4321;
		state.config['kernelWorkbench.run.cmdline'] = 'loglevel=8';
		const { args } = runner.vmCommand(configured('x86_64'), true);
		assert.equal(args[args.indexOf('-append') + 1], 'console=ttyS0 nokaslr loglevel=8');
		assert.ok(args.join(' ').endsWith('-gdb tcp:localhost:4321 -S'));
		assert.ok(!runner.vmCommand(configured('x86_64')).args.includes('-S'), 'not for Run');
	});

	it('makes debug configurations for cpptools, Native Debug and CodeLLDB', () => {
		const { runner } = fixture();
		state.config['kernelWorkbench.debug.gdbCommands'] = ['set print elements 0'];
		const st = configured('arm64');
		const cpp = runner.debugConfiguration(st, 'cppdbg', 1234);
		assert.equal(cpp.type, 'cppdbg');
		assert.equal(cpp.miDebuggerServerAddress, 'localhost:1234');
		assert.equal(cpp.program, path.join(st.buildDir, 'vmlinux'));
		const texts = cpp.setupCommands.map((c: { text: string }) => c.text);
		assert.ok(texts.includes(`add-auto-load-safe-path ${st.buildDir}`));
		assert.ok(texts.includes('set print elements 0'));
		const gdb = runner.debugConfiguration(st, 'gdb', 99);
		assert.equal(gdb.type, 'gdb');
		assert.equal(gdb.target, 'localhost:99');
		const lldb = runner.debugConfiguration(st, 'lldb', 5);
		assert.deepEqual(lldb.processCreateCommands, ['gdb-remote localhost:5']);
	});

	it('picks the installed debugger and offers to install one', async () => {
		const { runner } = fixture();
		assert.equal(runner.debuggerFlavor(), 'cppdbg');
		state.extensions = { 'webfreak.debug': {} };
		assert.equal(runner.debuggerFlavor(), 'gdb');
		state.config['kernelWorkbench.debug.debugger'] = 'lldb';
		assert.equal(runner.debuggerFlavor(), 'lldb');
		assert.equal(await runner.checkDebugger('lldb'), false);
		assert.match(String(state.log.pop()?.message), /vadimcn\.vscode-lldb/);
		assert.equal(await runner.checkDebugger('gdb'), true);
	});

	it('hands over to the IDE debugger once the guest is at the symbol', async () => {
		const { settings, runner } = fixture();
		const st = configured(settings.arch, settings.buildDir());
		runner.checkDebugger = async () => true;
		runner.prepare = async () => st;
		runner.boot = () => {};
		// A gdbstub stand-in that accepts the connection.
		const server = net.createServer(socket => socket.end()).listen(0);
		await new Promise(resolve => server.once('listening', resolve));
		const port = (server.address() as net.AddressInfo).port;
		state.config['kernelWorkbench.debug.port'] = port;
		state.config['kernelWorkbench.debug.breakAt'] = '';
		try {
			await runner.debug();
		} finally {
			server.close();
		}
		assert.equal(state.debugSessions.length, 1);
		assert.equal(state.debugSessions[0].miDebuggerServerAddress, `localhost:${port}`);
	});

	it('asks before debugging a Release build', async () => {
		const { settings, runner } = fixture();
		await settings.select('variant', 'release');
		answer(undefined);
		await runner.debug();
		assert.match(String(state.log.pop()?.message), /Release build has no debug info/);
		assert.equal(state.debugSessions.length, 0);
	});
});
