// Helpers for the tests that run inside VS Code with a real kernel tree open.
import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KernelWorkbench } from '../../extension';

export const ID = 'ajose.kernel-workbench';

/** The kernel tree the tests run on: the open workspace folder. */
export function tree(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error('no workspace folder is open');
	}
	return folder.uri.fsPath;
}

/** The activated extension's parts (activate() returns them for the tests). */
export async function api(): Promise<KernelWorkbench> {
	const extension = vscode.extensions.getExtension<KernelWorkbench | undefined>(ID);
	if (!extension) {
		throw new Error(`${ID} is not installed`);
	}
	const parts = extension.isActive ? extension.exports : await extension.activate();
	if (!parts) {
		throw new Error(`${ID} did not activate in ${tree()}`);
	}
	return parts;
}

/** The label of a tree item, as shown. */
function labelOf(item: vscode.TreeItem): string {
	return typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
}

/** Rows of a tree view as "label — description", one level or two (children indented). */
export async function labels<T>(
	provider: vscode.TreeDataProvider<T>,
	element?: T,
	depth = 1,
): Promise<string[]> {
	const rows: string[] = [];
	for (const item of (await provider.getChildren(element)) ?? []) {
		const row = await provider.getTreeItem(item);
		rows.push(`${labelOf(row)}${row.description ? ` — ${row.description}` : ''}`);
		if (depth > 1 && row.collapsibleState) {
			rows.push(...(await labels(provider, item, depth - 1)).map(l => `  ${l}`));
		}
	}
	return rows;
}

/** The child of `element` (a top-level row when omitted) with that label. */
export async function child<T>(
	provider: vscode.TreeDataProvider<T>,
	label: string,
	element?: T,
): Promise<T | undefined> {
	for (const item of (await provider.getChildren(element)) ?? []) {
		if (labelOf(await provider.getTreeItem(item)) === label) {
			return item;
		}
	}
	return undefined;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Prompt =
	| 'showInputBox'
	| 'showQuickPick'
	| 'showOpenDialog'
	| 'showWarningMessage'
	| 'showInformationMessage'
	| 'showErrorMessage';

/**
 * Replaces a vscode.window prompt for one test, answering from a queue (a function gets the
 * items offered); the extension shares this API object with the tests. Call restore() after.
 */
export function answer(name: Prompt, answers: unknown[]) {
	const window = vscode.window as unknown as Record<string, (...args: any[]) => Promise<unknown>>;
	const original = window[name];
	const asked: unknown[][] = [];
	window[name] = async (...args: unknown[]) => {
		asked.push(args);
		const next = answers.length ? answers.shift() : undefined;
		return typeof next === 'function' ? next(await args[0], args) : next;
	};
	return {
		asked,
		restore: () => {
			window[name] = original;
		},
	};
}

/** Waits until condition() is truthy, polling; returns the milliseconds it took. */
export async function until(
	condition: () => boolean | Promise<boolean>,
	timeout = 60000,
	step = 25,
): Promise<number> {
	const start = Date.now();
	while (!(await condition())) {
		if (Date.now() - start > timeout) {
			throw new Error(`timed out after ${timeout} ms`);
		}
		await sleep(step);
	}
	return Date.now() - start;
}

/** A file of the kernel tree. */
export const file = (relative: string) => vscode.Uri.file(path.join(tree(), relative));

/**
 * A minimal initramfs around the host's static busybox, built with the tree's
 * usr/gen_init_cpio.c; its init prints KWB-INIT-RAN and starts a shell on the console.
 * @returns the .cpio
 */
export function busyboxInitramfs(): string {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kwb-initramfs-'));
	execFileSync('cc', [
		'-O2',
		'-o',
		path.join(work, 'gen_init_cpio'),
		path.join(tree(), 'usr/gen_init_cpio.c'),
	]);
	fs.writeFileSync(
		path.join(work, 'init'),
		'#!/bin/busybox sh\n/bin/busybox --install -s\nmount -t proc proc /proc\n' +
			'mount -t sysfs sysfs /sys\necho KWB-INIT-RAN\nexec sh\n',
		{ mode: 0o755 },
	);
	const list = [
		'dir /dev 0755 0 0',
		'nod /dev/console 0600 0 0 c 5 1',
		'dir /proc 0755 0 0',
		'dir /sys 0755 0 0',
		'dir /mnt 0755 0 0',
		'dir /bin 0755 0 0',
		'dir /sbin 0755 0 0',
		'dir /usr 0755 0 0',
		'dir /usr/bin 0755 0 0',
		'dir /usr/sbin 0755 0 0',
		'file /bin/busybox /bin/busybox 0755 0 0',
		`file /init ${work}/init 0755 0 0`,
	];
	fs.writeFileSync(path.join(work, 'list'), list.join('\n'));
	const cpio = path.join(work, 'initramfs.cpio');
	fs.writeFileSync(
		cpio,
		execFileSync(path.join(work, 'gen_init_cpio'), [path.join(work, 'list')], {
			maxBuffer: 256 << 20,
		}),
	);
	return cpio;
}

/**
 * A two-patch series on the branch kwb-series over kwb-base (the clone's original HEAD):
 * the first commit with style errors, the second clean. Made afresh each time, so that the
 * test files, which run in any order, all see the same series.
 */
export function seriesBranch(): void {
	const git = seriesBranch.git;
	const branches = git('branch', '--list', 'kwb-base');
	if (!branches.trim()) {
		git('branch', 'kwb-base', 'HEAD');
	}
	git('checkout', '-q', '-B', 'kwb-series', 'kwb-base');
	const f = path.join(tree(), 'drivers/gpu/drm/virtio/virtgpu_drv.c');
	fs.appendFileSync(f, '\nint kwb_test_var=0;   \n');
	git('commit', '-q', '-a', '-m', 'drm/virtio: add a test variable');
	fs.appendFileSync(f, '\nstatic int kwb_test_fn(void)\n{\n\treturn 0;\n}\n');
	git(
		'commit',
		'-q',
		'-a',
		'-s',
		'-m',
		'drm/virtio: add a test function',
		'-m',
		'A short description of the change.',
	);
}

/** git in the clone, as the test identity. */
seriesBranch.git = (...args: string[]) =>
	execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
		cwd: tree(),
		encoding: 'utf8',
	});
