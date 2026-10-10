import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { archInfo, isNative } from './arch';
import type { Kbuild } from './kbuild';
import type { Configured, Settings } from './settings';
import { sq } from './tasks';

/** Marks the debug configurations this extension starts. */
const SESSION_MARKER = '__kernelWorkbenchVm';

type Flavor = 'cppdbg' | 'gdb' | 'lldb';

/** Boots the built kernel in QEMU, in a terminal, and keeps track of the VM. */
export class Runner {
	/** The VM's terminal, while one is open. */
	vm: vscode.Terminal | undefined;
	/** Where the VM's wrapper writes QEMU's exit code. */
	private exitFile: string | undefined;
	private exitWatch: fs.FSWatcher | undefined;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	/** Fires when the VM starts or stops. */
	readonly onDidChange = this._onDidChange.event;
	/** Called with the console log and the build when a QEMU boot starts. */
	onBoot: ((log: string, state: Configured) => void) | undefined;

	constructor(
		context: vscode.ExtensionContext,
		private readonly settings: Settings,
		private readonly kbuild: Kbuild,
	) {
		context.subscriptions.push(
			this._onDidChange,
			{ dispose: () => this.exitWatch?.close() },
			vscode.window.onDidCloseTerminal(terminal => {
				if (terminal === this.vm) {
					this.vm = undefined;
					this._onDidChange.fire();
				}
			}),
			vscode.debug.onDidTerminateDebugSession(session => {
				const stopVm = this.settings.get('debug.stopVmWhenDebuggingEnds', true);
				if (session.configuration[SESSION_MARKER] && stopVm) {
					this.stop();
				}
			}),
		);
	}

	/**
	 * The VM's terminal is open and QEMU has not exited (a failed QEMU's terminal stays
	 * open to be read).
	 */
	get running(): boolean {
		return (
			!!this.vm &&
			this.vm.exitStatus === undefined &&
			!(this.exitFile && fs.existsSync(this.exitFile))
		);
	}

	stop(): void {
		const vm = this.vm;
		this.vm = undefined;
		this.exitWatch?.close();
		this.exitWatch = undefined;
		vm?.dispose();
	}

	/** Ctrl+F5: build if needed, then boot. */
	async run(): Promise<void> {
		const state = await this.prepare();
		if (state) {
			this.boot(state, false);
		}
	}

	/**
	 * F5: build if needed, boot halted with a gdbstub, run to a symbol on a hardware
	 * breakpoint, then attach the IDE debugger there. At reset the MMU is off (and an x86
	 * bzImage has not decompressed the kernel yet), so software breakpoints set by the IDE
	 * would fail or be overwritten; once at start_kernel they stick.
	 */
	async debug(): Promise<void> {
		if (this.settings.variant === 'release') {
			const pick = await vscode.window.showWarningMessage(
				'Kernel: the Release build has no debug info. Switch to Debug?',
				'Switch to Debug',
				'Debug Anyway',
			);
			if (!pick) {
				return;
			}
			if (pick === 'Switch to Debug') {
				await this.settings.select('variant', 'debug');
			}
		}
		const flavor = this.debuggerFlavor();
		if (!(await this.checkDebugger(flavor))) {
			return;
		}
		const state = await this.prepare();
		if (!state) {
			return;
		}

		const port = this.settings.get('debug.port', 1234);
		const breakAt = this.settings.get('debug.breakAt', 'start_kernel');
		this.boot(state, true);

		const ok = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Kernel: booting ${state.arch} ${state.variant}`,
				cancellable: true,
			},
			async (progress, cancel) => {
				progress.report({ message: 'waiting for gdbstub…' });
				if (!(await waitForPort(port, 30000, cancel))) {
					if (!cancel.isCancellationRequested) {
						vscode.window.showErrorMessage(
							`Kernel: QEMU gdbstub did not come up on port ${port}; ` +
								'see the VM terminal.',
						);
					}
					return false;
				}
				if (!breakAt) {
					return true;
				}
				progress.report({ message: `running to ${breakAt}…` });
				try {
					const vmlinux = this.kbuild.vmlinux(state);
					await runToSymbol(this.settings.gdbPath(), vmlinux, port, breakAt, cancel);
					return true;
				} catch (e) {
					if (!cancel.isCancellationRequested) {
						const reason = (e as Error).message;
						vscode.window.showErrorMessage(
							`Kernel: could not reach ${breakAt}: ${reason}`,
						);
					}
					return false;
				}
			},
		);
		if (!ok) {
			this.stop();
			return;
		}
		await vscode.debug.startDebugging(
			this.settings.folder,
			this.debugConfiguration(state, flavor, port),
		);
	}

	/** Configured, built (when kernelWorkbench.buildBeforeRun) and the initramfs there. */
	async prepare(): Promise<Configured | undefined> {
		if (this.settings.get('buildBeforeRun', true)) {
			if ((await this.kbuild.build()) !== 0) {
				vscode.window.showErrorMessage('Kernel: build failed; see the Build terminal.');
				return undefined;
			}
		}
		const state = this.settings.configured();
		if (!state || !fs.existsSync(this.kbuild.image(state))) {
			const target = `${this.settings.arch} ${this.settings.variant}`;
			vscode.window.showErrorMessage(`Kernel: no ${target} kernel image. Build first.`);
			return undefined;
		}
		const virtme = this.settings.get('run.mode', 'qemu') === 'virtme';
		if (!virtme && !(await this.checkInitramfs(state))) {
			return undefined;
		}
		return state;
	}

	/** kernelWorkbench.run.initramfs.<arch>, or undefined to boot without one. */
	initramfsPath(state: Configured): string | undefined {
		const custom = this.settings.get<Record<string, string>>('run.initramfs', {})[state.arch];
		return custom ? path.resolve(this.settings.root, custom) : undefined;
	}

	/**
	 * A configured initramfs that does not exist is an error, not a reason to silently
	 * boot without it.
	 */
	async checkInitramfs(state: Configured): Promise<boolean> {
		const file = this.initramfsPath(state);
		if (!file || fs.existsSync(file)) {
			return true;
		}
		const pick = await vscode.window.showErrorMessage(
			`Kernel: initramfs ${file} ` +
				`(kernelWorkbench.run.initramfs.${state.arch}) does not exist.`,
			'Open Setting',
		);
		if (pick) {
			await vscode.commands.executeCommand(
				'workbench.action.openSettings',
				'kernelWorkbench.run.initramfs',
			);
		}
		return false;
	}

	useKvm(arch: string): boolean {
		const kvm = this.settings.get('run.kvm', 'auto');
		if (kvm === 'on') {
			return true;
		}
		if (kvm === 'off' || !isNative(arch)) {
			return false;
		}
		try {
			fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
			return true;
		} catch {
			return false;
		}
	}

	/** The command line that boots the build, QEMU or vng; `debug`: halted, with a gdbstub. */
	vmCommand(state: Configured, debug = false): { cmd: string; args: string[] } {
		const settings = this.settings;
		const info = archInfo(state.arch);
		const port = settings.get('debug.port', 1234);
		const qemuArgs = settings.get<string[]>('run.qemuArgs', []);
		const memory = settings.get('run.memory', '2G');
		const smp = String(settings.get('run.smp', 2));
		const gdbArgs = debug ? ['-gdb', `tcp:localhost:${port}`, '-S'] : [];
		const cmdline = [debug ? 'nokaslr' : '', settings.get('run.cmdline', '')]
			.filter(Boolean)
			.join(' ');

		if (settings.get('run.mode', 'qemu') === 'virtme') {
			const args = ['--run', this.kbuild.image(state), '--arch', info.vngArch];
			args.push('--memory', memory, '--cpus', smp);
			if (cmdline) {
				args.push('--append', cmdline);
			}
			const qemuOpts = [...qemuArgs, ...gdbArgs];
			if (qemuOpts.length) {
				args.push('--qemu-opts', qemuOpts.join(' '));
			}
			return { cmd: 'vng', args: args.concat(settings.get<string[]>('run.virtmeArgs', [])) };
		}

		const initramfs = this.initramfsPath(state);
		const share = settings.get('run.shareBuildDir', false)
			? [
					'-virtfs',
					`local,path=${state.buildDir},mount_tag=kbuild,security_model=none,readonly=on`,
				]
			: [];
		return {
			cmd: info.qemu,
			args: [
				...(this.useKvm(state.arch) ? info.machineKvm : info.machine),
				'-smp',
				smp,
				'-m',
				memory,
				'-kernel',
				this.kbuild.image(state),
				...(initramfs ? ['-initrd', initramfs] : []),
				'-append',
				[`console=${info.console}`, cmdline].filter(Boolean).join(' '),
				// The console also goes to a log file; mux=on keeps the Ctrl-A monitor keys
				// of -nographic.
				'-nographic',
				'-chardev',
				`stdio,id=kdcon,mux=on,signal=off,logfile=${this.consoleLog(state)}`,
				'-serial',
				'chardev:kdcon',
				'-mon',
				'chardev=kdcon,mode=readline',
				'-no-reboot',
				...share,
				...qemuArgs,
				...gdbArgs,
			],
		};
	}

	/** Where the VM's console is logged. */
	consoleLog(state: Configured): string {
		return path.join(state.buildDir, 'kernel-workbench', 'console.log');
	}

	/** Boots the build in a new VM terminal, stopping a running VM first. */
	boot(state: Configured, debug = false): void {
		this.stop();
		const { cmd, args } = this.vmCommand(state, debug);
		const virtme = this.settings.get('run.mode', 'qemu') === 'virtme';
		const shared = !virtme && this.settings.get('run.shareBuildDir', false);
		// VS Code closes a terminal when its process exits, which would take QEMU's error
		// with it: a wrapper records the exit code and, on a failure, keeps the terminal
		// until a key is pressed. A clean exit (poweroff, Ctrl-A X) closes it.
		const dir = path.join(state.buildDir, 'kernel-workbench');
		fs.mkdirSync(dir, { recursive: true });
		this.exitFile = path.join(dir, 'vm.exit');
		fs.rmSync(this.exitFile, { force: true });
		this.exitWatch = fs.watch(dir, (_event, file) => {
			if (file === 'vm.exit') {
				this._onDidChange.fire();
			}
		});
		this.exitWatch.unref(); // never what keeps the extension host alive
		const wrapper =
			`"$@"; rc=$?; echo $rc > ${sq(this.exitFile)}; ` +
			`if [ $rc -ne 0 ]; then ` +
			`printf '\\n%s exited with %d. Press a key to close.' "$1" $rc; ` +
			`read -rn1; fi; exit $rc`;
		this.vm = vscode.window.createTerminal({
			name: `${debug ? 'Debug' : 'Run'} ${state.arch} ${state.variant}`,
			cwd: this.settings.root,
			shellPath: 'bash',
			shellArgs: ['-c', wrapper, 'kernel-vm', cmd, ...args],
			message:
				`\x1b[2m$ ${[cmd, ...args].map(sq).join(' ')}\r\n` +
				`(Ctrl-A X quits QEMU)\x1b[0m\r\n` +
				(shared
					? '\x1b[2mBuild directory shared; in the guest: mkdir -p /mnt/kbuild && ' +
						'mount -t 9p -o trans=virtio,version=9p2000.L kbuild /mnt/kbuild\r\n' +
						'then e.g. insmod /mnt/kbuild/drivers/.../foo.ko\x1b[0m\r\n'
					: ''),
			iconPath: new vscode.ThemeIcon(debug ? 'debug-alt' : 'vm-running'),
		});
		this.vm.show();
		this._onDidChange.fire();
		if (!virtme) {
			const log = this.consoleLog(state);
			fs.mkdirSync(path.dirname(log), { recursive: true });
			fs.writeFileSync(log, '');
			this.onBoot?.(log, state);
		}
	}

	/** The debugger front end: the setting, or the first installed. */
	debuggerFlavor(): Flavor {
		const want = this.settings.get('debug.debugger', 'auto');
		if (want === 'cppdbg' || want === 'gdb' || want === 'lldb') {
			return want;
		}
		if (vscode.extensions.getExtension('ms-vscode.cpptools')) {
			return 'cppdbg';
		}
		if (vscode.extensions.getExtension('webfreak.debug')) {
			return 'gdb';
		}
		if (vscode.extensions.getExtension('vadimcn.vscode-lldb')) {
			return 'lldb';
		}
		return 'cppdbg';
	}

	/** Whether the front end's extension is installed; offers to install it. */
	async checkDebugger(flavor: Flavor): Promise<boolean> {
		const extension = {
			cppdbg: 'ms-vscode.cpptools',
			gdb: 'webfreak.debug',
			lldb: 'vadimcn.vscode-lldb',
		}[flavor];
		if (vscode.extensions.getExtension(extension)) {
			return true;
		}
		const pick = await vscode.window.showErrorMessage(
			`Kernel: debugging needs a gdb front end. Install ${extension}? ` +
				'(In VSCodium: webfreak.debug.)',
			'Install',
		);
		if (pick) {
			await vscode.commands.executeCommand(
				'workbench.extensions.installExtension',
				extension,
			);
		}
		return false;
	}

	/** An in-memory debug configuration; nothing is written to launch.json. */
	debugConfiguration(state: Configured, flavor: Flavor, port: number): vscode.DebugConfiguration {
		const root = this.settings.root;
		const vmlinux = this.kbuild.vmlinux(state);
		const gdb = this.settings.gdbPath();
		const target = `localhost:${port}`;
		const name = `Kernel ${state.arch} ${state.variant}`;
		const stopOnEntry = this.settings.get('debug.stopOnEntry', false);
		// vmlinux-gdb.py (lx-* commands) lives in the build dir and symlinks into
		// scripts/gdb in the source tree; both must be on the safe path.
		const gdbInit = [
			`add-auto-load-safe-path ${state.buildDir}`,
			`add-auto-load-safe-path ${path.join(root, 'scripts', 'gdb')}`,
			'set print pretty on',
			...this.settings.get<string[]>('debug.gdbCommands', []),
		];
		switch (flavor) {
			case 'gdb':
				return {
					type: 'gdb',
					request: 'attach',
					name,
					executable: vmlinux,
					target,
					remote: true,
					cwd: root,
					gdbpath: gdb,
					autorun: gdbInit,
					valuesFormatting: 'prettyPrinters',
					stopAtConnect: stopOnEntry,
					[SESSION_MARKER]: true,
				};
			case 'lldb':
				return {
					type: 'lldb',
					request: 'custom',
					name,
					targetCreateCommands: [`target create ${vmlinux}`],
					processCreateCommands: [`gdb-remote ${target}`],
					[SESSION_MARKER]: true,
				};
			default:
				return {
					type: 'cppdbg',
					request: 'launch',
					name,
					program: vmlinux,
					cwd: root,
					MIMode: 'gdb',
					miDebuggerPath: gdb,
					miDebuggerServerAddress: target,
					stopAtConnect: stopOnEntry,
					setupCommands: [
						{ text: '-enable-pretty-printing', ignoreFailures: true },
						...gdbInit.map(text => ({ text, ignoreFailures: true })),
					],
					[SESSION_MARKER]: true,
				};
		}
	}
}

/** Whether something listens on the port, within the timeout. */
async function waitForPort(
	port: number,
	timeoutMs: number,
	cancel: vscode.CancellationToken,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !cancel.isCancellationRequested) {
		const up = await new Promise<boolean>(resolve => {
			const socket = net.connect(port, '127.0.0.1');
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => resolve(false));
		});
		if (up) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	return false;
}

/**
 * A throwaway gdb: hardware-break at `symbol`, continue, then `disconnect` (not detach)
 * so that QEMU stays halted there for the IDE debugger.
 */
function runToSymbol(
	gdb: string,
	vmlinux: string,
	port: number,
	symbol: string,
	cancel: vscode.CancellationToken,
): Promise<void> {
	const script = path.join(__dirname, '..', 'scripts', 'run-to.py');
	return new Promise((resolve, reject) => {
		const child = execFile(
			gdb,
			['-q', '-nx', '-batch', '-ex', `file ${vmlinux}`, '-x', script],
			{
				env: { ...process.env, KWB_TARGET: `localhost:${port}`, KWB_SYMBOL: symbol },
				timeout: 10 * 60 * 1000,
				maxBuffer: 16 << 20,
			},
			(error, stdout, stderr) => {
				if (/^kernel-workbench: stopped at \S+ \(pc=/m.test(stdout)) {
					resolve();
				} else if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
					reject(
						new Error(
							`${gdb} not found ` +
								'(install gdb-multiarch, or set kernelWorkbench.debug.gdb)',
						),
					);
				} else {
					const reason = (stderr || stdout || String(error))
						.trim()
						.split('\n')
						.slice(-3)
						.join(' ');
					reject(new Error(reason));
				}
			},
		);
		cancel.onCancellationRequested(() => child.kill());
	});
}
