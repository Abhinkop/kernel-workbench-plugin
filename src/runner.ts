import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { archInfo, isNative } from './arch';
import type { Kbuild } from './kbuild';
import type { Configured, Settings } from './settings';
import { sq } from './tasks';

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
			this.boot(state);
		}
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
		if (!(await this.checkInitramfs(state))) {
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

	/** The QEMU command line that boots the build. */
	vmCommand(state: Configured): { cmd: string; args: string[] } {
		const settings = this.settings;
		const info = archInfo(state.arch);
		const initramfs = this.initramfsPath(state);
		const cmdline = settings.get('run.cmdline', '');
		return {
			cmd: info.qemu,
			args: [
				...(this.useKvm(state.arch) ? info.machineKvm : info.machine),
				'-smp',
				String(settings.get('run.smp', 2)),
				'-m',
				settings.get('run.memory', '2G'),
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
				...settings.get<string[]>('run.qemuArgs', []),
			],
		};
	}

	/** Where the VM's console is logged. */
	consoleLog(state: Configured): string {
		return path.join(state.buildDir, 'kernel-workbench', 'console.log');
	}

	/** Boots the build in a new VM terminal, stopping a running VM first. */
	boot(state: Configured): void {
		this.stop();
		const { cmd, args } = this.vmCommand(state);
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
			name: `Run ${state.arch} ${state.variant}`,
			cwd: this.settings.root,
			shellPath: 'bash',
			shellArgs: ['-c', wrapper, 'kernel-vm', cmd, ...args],
			message:
				`\x1b[2m$ ${[cmd, ...args].map(sq).join(' ')}\r\n` +
				`(Ctrl-A X quits QEMU)\x1b[0m\r\n`,
			iconPath: new vscode.ThemeIcon('vm-running'),
		});
		this.vm.show();
		this._onDidChange.fire();
		const log = this.consoleLog(state);
		fs.mkdirSync(path.dirname(log), { recursive: true });
		fs.writeFileSync(log, '');
	}
}
