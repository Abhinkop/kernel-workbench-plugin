// Runs inside VS Code with a throwaway clone of a real kernel open (npm run
// test:integration): what Debug asks or refuses, and, with KERNEL_E2E=1, the built kernel
// booted halted, run to start_kernel and handed to the debugger (checked with gdb, and
// with the C/C++ extension when it is installed in the test VS Code).
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { answer, api, until } from './helpers';
import type { KernelWorkbench } from '../../extension';

describe('Debug in QEMU in VS Code', function () {
	this.timeout(30 * 60 * 1000);
	let x: KernelWorkbench;
	const cfg = () =>
		vscode.workspace.getConfiguration(
			'kernelWorkbench',
			vscode.workspace.workspaceFolders?.[0],
		);
	const set = (key: string, value: unknown) =>
		cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
	const cpptools = () => vscode.extensions.getExtension('ms-vscode.cpptools');

	before(async () => {
		x = await api();
		await x.settings.select('arch', 'x86_64');
		await x.settings.select('variant', 'debug');
		await x.settings.select('config', 'defconfig');
	});

	after(async () => {
		for (const key of ['buildBeforeRun', 'run.kvm', 'debug.stopOnEntry']) {
			await set(key, undefined);
		}
	});

	it('asks before debugging a Release build', async () => {
		await x.settings.select('variant', 'release');
		const warnings = answer('showWarningMessage', [undefined]);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.debug');
		} finally {
			warnings.restore();
			await x.settings.select('variant', 'debug');
		}
		assert.match(String(warnings.asked[0]?.[0]), /Release build has no debug info/);
		assert.ok(!x.runner.running);
	});

	it('offers to install a debugger front end when none is installed', async function () {
		if (cpptools()) {
			this.skip();
		}
		const errors = answer('showErrorMessage', [undefined]);
		try {
			await vscode.commands.executeCommand('kernelWorkbench.debug');
		} finally {
			errors.restore();
		}
		assert.match(
			String(errors.asked[0]?.[0]),
			/needs a gdb front end\. Install ms-vscode\.cpptools/,
		);
		assert.ok(!x.runner.running);
	});

	const e2e = process.env.KERNEL_E2E === '1' ? it : it.skip;

	e2e('hands the debugger a guest halted at start_kernel', async () => {
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.build'), 0);
		await set('buildBeforeRun', false);
		await set('run.kvm', fs.existsSync('/dev/kvm') ? 'auto' : 'off');
		const started: vscode.DebugConfiguration[] = [];
		const original = vscode.debug.startDebugging;
		const check = x.runner.checkDebugger;
		vscode.debug.startDebugging = async (_folder, config) => {
			started.push(config as vscode.DebugConfiguration);
			return true;
		};
		x.runner.checkDebugger = async () => true; // no gdb front end needed for this check
		const errors = answer('showErrorMessage', []);
		try {
			await x.runner.debug();
			assert.strictEqual(
				started.length,
				1,
				`no debug session; errors: ${errors.asked.map(a => a[0]).join(' | ')}`,
			);
			const recorded = x.settings.configured();
			assert.ok(recorded);
			const out = execFileSync(
				x.settings.gdbPath(),
				[
					'-q',
					'-nx',
					'-batch',
					'-ex',
					`file ${x.kbuild.vmlinux(recorded)}`,
					'-ex',
					`target remote ${started[0].miDebuggerServerAddress}`,
					'-ex',
					'info symbol $pc',
					'-ex',
					'kill',
				],
				{ encoding: 'utf8' },
			);
			assert.match(out, /^start_kernel/m);
		} finally {
			vscode.debug.startDebugging = original;
			x.runner.checkDebugger = check;
			errors.restore();
			x.runner.stop();
		}
	});

	e2e('attaches the C/C++ debugger to the guest at start_kernel', async function () {
		if (!cpptools()) {
			this.skip();
		}
		assert.strictEqual(await vscode.commands.executeCommand('kernelWorkbench.build'), 0);
		await set('buildBeforeRun', false);
		await set('run.kvm', fs.existsSync('/dev/kvm') ? 'auto' : 'off');
		// Stay where the hand-off stopped instead of continuing (the default).
		await set('debug.stopOnEntry', true);
		let stopped: { threadId?: number } | undefined;
		const tracker = vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', {
			createDebugAdapterTracker: () => ({
				onDidSendMessage: (message: { type: string; event?: string; body?: unknown }) => {
					if (message.type === 'event' && message.event === 'stopped') {
						stopped = message.body as { threadId?: number };
					}
				},
			}),
		});
		try {
			await x.runner.debug();
			await until(() => !!vscode.debug.activeDebugSession, 120000, 250);
			const session = vscode.debug.activeDebugSession;
			assert.ok(session);
			assert.strictEqual(session.type, 'cppdbg');
			const recorded = x.settings.configured();
			assert.ok(recorded);
			assert.strictEqual(session.configuration.program, x.kbuild.vmlinux(recorded));
			await until(() => !!stopped, 60000, 250);
			const threads = await session.customRequest('threads');
			const threadId = stopped?.threadId ?? threads.threads[0].id;
			const stack = await session.customRequest('stackTrace', { threadId, levels: 5 });
			const names = stack.stackFrames.map((f: { name: string }) => f.name);
			assert.match(names[0], /start_kernel/, names.join(' < '));
			assert.match(stack.stackFrames[0].source.path, /init[/\\]main\.c$/);
		} finally {
			tracker.dispose();
			if (vscode.debug.activeDebugSession) {
				await vscode.debug.stopDebugging();
			}
			await until(() => !vscode.debug.activeDebugSession, 30000, 250).catch(() => undefined);
			// debug.stopVmWhenDebuggingEnds (default on) stops QEMU with the session.
			await until(() => !x.runner.running, 30000, 250).catch(() => x.runner.stop());
		}
	});
});
