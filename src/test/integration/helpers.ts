// Helpers for the tests that run inside VS Code with a real kernel tree open.
import * as vscode from 'vscode';
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
