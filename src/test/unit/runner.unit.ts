// Booting the built kernel in QEMU: the command line, the VM terminal under its exit-code
// wrapper, the console log, and what Run refuses.
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { extensionContext, state, workspaceFolder } from '../helpers/vscode';
import { tempDir } from '../helpers/repo';
import { Kbuild } from '../../kbuild';
import { Runner } from '../../runner';
import { Settings } from '../../settings';
import type { Configured } from '../../settings';

describe('runner', () => {
	function fixture(root = tempDir()) {
		const settings = new Settings(extensionContext(), workspaceFolder(root));
		const kbuild = new Kbuild(settings);
		return { settings, kbuild, runner: new Runner(extensionContext(), settings, kbuild) };
	}

	/** A configured state for `arch` in a fresh build directory. */
	const configured = (arch: string, buildDir = tempDir()): Configured => ({
		arch,
		variant: 'debug',
		config: 'defconfig',
		buildDir,
		makeArgs: [`O=${buildDir}`, `ARCH=${arch}`, 'CROSS_COMPILE='],
		configuredAt: new Date().toISOString(),
	});

	it('builds the QEMU command for each architecture', () => {
		const { runner } = fixture();
		state.config['kernelWorkbench.run.kvm'] = 'off';
		const expected: [string, string, string][] = [
			['x86_64', 'qemu-system-x86_64', 'bzImage'],
			['arm64', 'qemu-system-aarch64', 'Image'],
			['riscv64', 'qemu-system-riscv64', 'Image'],
		];
		for (const [arch, qemu, image] of expected) {
			const { cmd, args } = runner.vmCommand(configured(arch));
			assert.equal(cmd, qemu);
			assert.ok(args[args.indexOf('-kernel') + 1].endsWith(image));
			assert.ok(!args.includes('-initrd'), 'no initramfs set');
			assert.ok(!args.includes('-enable-kvm'));
			assert.ok(args.includes('-nographic'));
			assert.ok(args.some(a => /^stdio,id=kdcon,mux=on,signal=off,logfile=/.test(a)));
			assert.match(args[args.indexOf('-append') + 1], /^console=/);
		}
	});

	it('adds the initramfs, KVM, the command line and extra arguments', () => {
		const { runner } = fixture();
		state.config['kernelWorkbench.run.initramfs'] = { x86_64: '/srv/x86.cpio.gz' };
		state.config['kernelWorkbench.run.qemuArgs'] = ['-device', 'virtio-rng-pci'];
		state.config['kernelWorkbench.run.cmdline'] = 'loglevel=8';
		state.config['kernelWorkbench.run.kvm'] = 'on';
		state.config['kernelWorkbench.run.memory'] = '4G';
		state.config['kernelWorkbench.run.smp'] = 4;
		const { args } = runner.vmCommand(configured('x86_64'));
		assert.equal(args[args.indexOf('-initrd') + 1], '/srv/x86.cpio.gz');
		assert.equal(args[args.indexOf('-append') + 1], 'console=ttyS0 loglevel=8');
		assert.ok(args.includes('-enable-kvm'));
		assert.equal(args[args.indexOf('-m') + 1], '4G');
		assert.equal(args[args.indexOf('-smp') + 1], '4');
		assert.ok(args.join(' ').endsWith('-device virtio-rng-pci'));
	});

	it('uses virtme-ng in virtme mode', () => {
		const { runner } = fixture();
		state.config['kernelWorkbench.run.mode'] = 'virtme';
		state.config['kernelWorkbench.run.virtmeArgs'] = ['--verbose'];
		state.config['kernelWorkbench.run.qemuArgs'] = ['-device', 'virtio-rng-pci'];
		const { cmd, args } = runner.vmCommand(configured('arm64'), true);
		assert.equal(cmd, 'vng');
		assert.deepEqual(args.slice(0, 1), ['--run']);
		assert.ok(args.includes('--arch') && args.includes('arm64'));
		assert.ok(args.includes('--append') && args.includes('nokaslr'));
		assert.ok(
			args
				.join(' ')
				.includes('--qemu-opts -device virtio-rng-pci -gdb tcp:localhost:1234 -S'),
		);
		assert.equal(args[args.length - 1], '--verbose');
	});

	it('shares the build directory over 9p, and says how to mount it', () => {
		const { runner } = fixture();
		state.config['kernelWorkbench.run.shareBuildDir'] = true;
		const st = configured('x86_64');
		const { args } = runner.vmCommand(st);
		const share =
			`-virtfs local,path=${st.buildDir},` +
			'mount_tag=kbuild,security_model=none,readonly=on';
		assert.ok(args.join(' ').includes(share));
		runner.boot(st);
		assert.match(
			String(state.terminals[0].options.message),
			/mount -t 9p .* kbuild \/mnt\/kbuild/,
		);
		runner.stop();
	});

	it('reports a missing initramfs instead of booting without it', async () => {
		const { runner } = fixture();
		const st = configured('x86_64');
		assert.equal(await runner.checkInitramfs(st), true, 'none set is fine');
		state.config['kernelWorkbench.run.initramfs'] = { x86_64: '/no/such.cpio' };
		assert.equal(await runner.checkInitramfs(st), false);
		assert.match(String(state.log.pop()?.message), /does not exist/);
	});

	it('boots in a terminal, logs the console, and stops', () => {
		const { runner } = fixture();
		const st = configured('x86_64');
		runner.boot(st);
		assert.equal(state.terminals.length, 1);
		const options = state.terminals[0].options;
		assert.equal(options.shellPath, 'bash');
		const shellArgs = options.shellArgs as string[];
		assert.equal(shellArgs[3], 'qemu-system-x86_64', 'QEMU runs under the exit-code wrapper');
		assert.ok(runner.running);
		const log = runner.consoleLog(st);
		assert.equal(log, path.join(st.buildDir, 'kernel-workbench', 'console.log'));
		assert.ok(fs.existsSync(log));
		runner.stop();
		assert.ok(!runner.running);
		assert.ok(state.terminals[0].disposed);
	});

	it("keeps a failed QEMU's terminal open, but not as a running VM", async () => {
		const { runner } = fixture();
		const st = configured('x86_64');
		runner.vmCommand = () => ({
			cmd: 'sh',
			args: ['-c', 'echo "qemu: could not open kernel" >&2; exit 1'],
		});
		let changed = 0;
		runner.onDidChange(() => changed++);
		runner.boot(st);
		const options = state.terminals[0].options;
		// Run the wrapper as the terminal would, with a key to press.
		const wrapper = spawnSync(options.shellPath as string, options.shellArgs as string[], {
			encoding: 'utf8',
			input: 'x',
		});
		assert.equal(wrapper.status, 1);
		assert.match(wrapper.stdout, /sh exited with 1\. Press a key to close\./);
		const exitFile = path.join(st.buildDir, 'kernel-workbench', 'vm.exit');
		assert.equal(fs.readFileSync(exitFile, 'utf8').trim(), '1');
		assert.ok(!runner.running, 'the terminal stays, the VM is not running');
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.ok(changed >= 2, 'boot and exit are announced');
		runner.stop();
	});

	it('runs after building, and refuses without a kernel image', async () => {
		const { settings, kbuild, runner } = fixture();
		kbuild.build = async () => 0;
		await runner.run();
		assert.match(String(state.log.pop()?.message), /no .* kernel image/);
		const st = configured(settings.arch, settings.buildDir());
		settings.saveConfigured(st);
		fs.mkdirSync(path.dirname(kbuild.image(st)), { recursive: true });
		fs.writeFileSync(kbuild.image(st), 'kernel');
		await runner.run();
		assert.equal(state.terminals.length, 1);
		runner.stop();
		kbuild.build = async () => 2;
		await runner.run();
		assert.match(String(state.log.pop()?.message), /build failed/);
		state.config['kernelWorkbench.buildBeforeRun'] = false;
		await runner.run();
		assert.equal(state.terminals.length, 2, 'booted without building');
		runner.stop();
	});
});
