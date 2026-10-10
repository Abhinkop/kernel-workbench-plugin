import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { openCommit } from './commits';
import { exists, fixesLine, git, gitStatus } from './git';
import type { Settings } from './settings';
import { runTask, sq } from './tasks';

/** A commit of the bisection. */
interface Step {
	hash: string;
	subject: string;
}

/**
 * git bisect, driven from the Kernel Git tab. The state lives in git (.git/BISECT_LOG), so
 * a bisect started on the command line shows up here too, and vice versa.
 */
export class Bisect {
	readonly root: string;
	active = false;
	/** The commit under test. */
	current: Step | undefined;
	/** What git says is left: "N revisions left to test after this (roughly M steps)". */
	remaining = '';
	/** The first bad commit, once found. */
	result: Step | undefined;
	/** The good/bad/skip steps so far, from git bisect log. */
	log: string[] = [];
	message = '';
	busy = '';
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		readonly settings: Settings,
	) {
		this.root = settings.root;
	}

	changed(): void {
		this._onDidChange.fire();
	}

	/** Reads the bisection's state from git. */
	async refresh(): Promise<void> {
		this.active = fs.existsSync(path.join(this.root, '.git', 'BISECT_LOG'));
		this.log = [];
		this.current = undefined;
		if (this.active) {
			const log = (await gitStatus(this.root, ['bisect', 'log'])).stdout;
			this.log = log
				.split('\n')
				.filter(l => /^# (good|bad|skip|first bad commit)/.test(l))
				.map(l => l.slice(2));
			const head = (await git(this.root, ['log', '-1', '--format=%H%x00%s']))
				.trim()
				.split('\0');
			this.current = { hash: head[0], subject: head[1] };
			const first = /^# first bad commit: \[([0-9a-f]+)\] (.*)$/m.exec(log);
			if (first) {
				this.result = { hash: first[1], subject: first[2] };
			}
		}
		this.changed();
	}

	async start(bad: string, good: string): Promise<void> {
		for (const rev of [bad, good]) {
			if (!(await exists(this.root, rev))) {
				vscode.window.showErrorMessage(`Kernel: "${rev}" is not a commit here.`);
				return;
			}
		}
		this.result = undefined;
		await this.step(['start', bad, good]);
	}

	/** Runs a git bisect subcommand and digests its answer. */
	async step(args: string[]): Promise<void> {
		this.busy = `git bisect ${args[0]}`;
		this.changed();
		const result = await gitStatus(this.root, ['bisect', ...args]);
		this.busy = '';
		const out = `${result.stdout}\n${result.stderr}`;
		const left = /Bisecting: (.*)$/m.exec(out);
		this.remaining = left ? left[1] : '';
		const first = /^([0-9a-f]{40}) is the first bad commit/m.exec(out);
		if (first) {
			const subject = (await git(this.root, ['log', '-1', '--format=%s', first[1]])).trim();
			this.result = { hash: first[1], subject };
			this.message = `First bad commit: ${first[1].slice(0, 12)} ${subject}`;
			await openCommit(this.root, first[1]);
		} else if (result.code !== 0) {
			this.message = out.trim().split('\n').slice(-3).join(' ');
		} else {
			this.message = '';
		}
		await this.refresh();
	}

	async reset(): Promise<void> {
		await this.step(['reset']);
		this.remaining = '';
		this.message = 'Bisect reset: back on the branch you started from.';
		this.changed();
	}

	/**
	 * git bisect run with a wrapper: build the selected kernel (a build failure tells git to
	 * skip the commit, exit 125), then run the user's test script with the build directory
	 * as its argument; its exit code says good (0) or bad (1-127 except 125).
	 */
	async run(script: string): Promise<void> {
		const state = this.settings.configured();
		if (!state) {
			vscode.window.showErrorMessage(
				'Kernel: configure a build in the Kernel tab first; each bisect step builds it.',
			);
			return;
		}
		const abs = path.resolve(this.root, script);
		if (!fs.existsSync(abs)) {
			vscode.window.showErrorMessage(`Kernel: test script ${abs} does not exist.`);
			return;
		}
		const dir = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
		fs.mkdirSync(dir, { recursive: true });
		const wrapper = path.join(dir, 'bisect-step.sh');
		const makeArgs = this.settings.makeArgs(state).map(sq).join(' ');
		const make = `make ${makeArgs} ${this.settings.jobs()}`;
		fs.writeFileSync(
			wrapper,
			[
				'#!/bin/sh',
				'# Written by Kernel Workbench for git bisect run.',
				`${make} >/dev/null 2>&1 || ` +
					'{ echo "bisect: build failed at $(git log -1 --format=%h), skipping"; ' +
					'exit 125; }',
				`exec ${sq(abs)} ${sq(state.buildDir)}`,
				'',
			].join('\n'),
			{ mode: 0o755 },
		);
		this.busy = 'git bisect run';
		this.changed();
		const code = await runTask(
			this.settings.folder,
			'git bisect run',
			'git',
			['bisect', 'run', wrapper],
			{ step: 'bisect' },
		);
		this.busy = '';
		await this.refresh();
		const log = (await gitStatus(this.root, ['bisect', 'log'])).stdout;
		const first = /^# first bad commit: \[([0-9a-f]+)\] (.*)$/m.exec(log);
		this.message = first
			? `First bad commit: ${first[1].slice(0, 12)} ${first[2]}`
			: `git bisect run ended (exit ${code}); see the terminal.`;
		if (first) {
			await openCommit(this.root, first[1]);
		}
		this.changed();
	}
}

export interface BisectItemOptions {
	description?: string;
	icon?: string;
	color?: string;
	tooltip?: string;
	contextValue?: string;
	children?: BisectItem[];
	command?: vscode.Command;
}

/** A row of the Bisect view. */
export class BisectItem extends vscode.TreeItem {
	readonly children?: BisectItem[];

	constructor(label: string, o: BisectItemOptions = {}) {
		super(
			label,
			o.children
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None,
		);
		this.description = o.description;
		if (o.icon) {
			this.iconPath = new vscode.ThemeIcon(
				o.icon,
				o.color ? new vscode.ThemeColor(o.color) : undefined,
			);
		}
		this.tooltip = o.tooltip;
		this.contextValue = o.contextValue;
		this.children = o.children;
		if (o.command) {
			this.command = o.command;
		}
	}
}

/** The Bisect view in the Kernel Git tab. */
export class BisectTree implements vscode.TreeDataProvider<BisectItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(readonly bisect: Bisect) {
		bisect.onDidChange(() => this.refresh());
	}

	refresh(): void {
		const b = this.bisect;
		vscode.commands.executeCommand('setContext', 'kernelWorkbench.bisectActive', b.active);
		vscode.commands.executeCommand(
			'setContext',
			'kernelWorkbench.bisectIdle',
			!b.active && !b.result && !b.busy && !b.message,
		);
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(item: BisectItem): vscode.TreeItem {
		return item;
	}

	getChildren(item?: BisectItem): BisectItem[] {
		if (item) {
			return item.children ?? [];
		}
		const b = this.bisect;
		const items: BisectItem[] = [];
		if (b.busy) {
			items.push(new BisectItem(b.busy, { icon: 'loading~spin' }));
		}
		const act = (label: string, command: string, icon: string, description: string) =>
			new BisectItem(label, {
				icon,
				description,
				tooltip: `Click to ${label.toLowerCase()}`,
				command: { command, title: label },
			});
		const open = (hash: string): vscode.Command => ({
			command: 'kernelWorkbench.git.openCommit',
			title: 'Open Commit',
			arguments: [hash],
		});
		if (b.active) {
			items.push(
				new BisectItem('Actions', {
					icon: 'play-circle',
					children: [
						act(
							'Build',
							'kernelWorkbench.build',
							'tools',
							'build the commit under test',
						),
						act('Run', 'kernelWorkbench.run', 'play', 'boot it in QEMU'),
						act('Mark good', 'kernelWorkbench.bisect.good', 'pass', 'git bisect good'),
						act('Mark bad', 'kernelWorkbench.bisect.bad', 'error', 'git bisect bad'),
						act(
							'Skip',
							'kernelWorkbench.bisect.skip',
							'debug-step-over',
							'git bisect skip',
						),
						act('Reset', 'kernelWorkbench.bisect.reset', 'discard', 'git bisect reset'),
					],
				}),
			);
		} else if (b.result) {
			items.push(
				new BisectItem('Actions', {
					icon: 'play-circle',
					children: [
						act(
							'Start another bisect…',
							'kernelWorkbench.bisect.start',
							'debug-start',
							'git bisect start',
						),
					],
				}),
			);
		}
		if (b.result) {
			items.push(
				new BisectItem(b.result.subject, {
					description: `first bad commit · ${b.result.hash.slice(0, 12)}`,
					icon: 'bug',
					color: 'problemsErrorIcon.foreground',
					contextValue: 'result',
					tooltip: b.result.hash,
					command: open(b.result.hash),
				}),
			);
		}
		if (b.active && b.current) {
			items.push(
				new BisectItem(b.current.subject, {
					description: `testing · ${b.current.hash.slice(0, 12)}`,
					icon: 'debug-breakpoint-unverified',
					tooltip: b.remaining || b.current.hash,
					command: open(b.current.hash),
				}),
			);
		}
		if (b.active && b.remaining) {
			items.push(new BisectItem('Remaining', { description: b.remaining, icon: 'history' }));
		}
		if (b.log.length) {
			items.push(
				new BisectItem('Steps', {
					description: String(b.log.length),
					icon: 'list-ordered',
					children: b.log.map(line => {
						const m = /^(good|bad|skip|first bad commit): \[([0-9a-f]+)\] (.*)$/.exec(
							line,
						);
						const kind = m ? m[1] : '';
						return new BisectItem(m ? m[3] : line, {
							description: m ? `${kind} · ${m[2].slice(0, 12)}` : '',
							icon:
								kind === 'good'
									? 'pass'
									: kind === 'bad' || kind === 'first bad commit'
										? 'error'
										: 'debug-step-over',
							color:
								kind === 'good'
									? 'testing.iconPassed'
									: kind === 'bad'
										? 'problemsErrorIcon.foreground'
										: undefined,
							command: m ? open(m[2]) : undefined,
						});
					}),
				}),
			);
		}
		if (b.message && !b.result) {
			items.push(new BisectItem(b.message, { icon: 'info', tooltip: b.message }));
		}
		return items;
	}
}

/** The Bisect view and its commands. */
export function registerBisect(
	context: vscode.ExtensionContext,
	settings: Settings,
): { bisect: Bisect; view: BisectTree } {
	const bisect = new Bisect(context, settings);
	const tree = new BisectTree(bisect);
	/** Asks for the bad and good commits and starts. */
	const start = async () => {
		const bad = await vscode.window.showInputBox({
			title: 'Bisect: bad commit (has the bug)',
			value: 'HEAD',
		});
		if (!bad) {
			return false;
		}
		const good = await vscode.window.showInputBox({
			title: 'Bisect: good commit (works)',
			prompt: 'e.g. v6.12, or a commit hash',
		});
		if (!good) {
			return false;
		}
		await bisect.start(bad.trim(), good.trim());
		return bisect.active;
	};
	const commands: [string, (...args: any[]) => unknown][] = [
		['kernelWorkbench.bisect.start', start],
		['kernelWorkbench.bisect.good', () => bisect.step(['good'])],
		['kernelWorkbench.bisect.bad', () => bisect.step(['bad'])],
		['kernelWorkbench.bisect.skip', () => bisect.step(['skip'])],
		['kernelWorkbench.bisect.reset', () => bisect.reset()],
		[
			'kernelWorkbench.bisect.run',
			async () => {
				if (!bisect.active && !(await start())) {
					return;
				}
				const uri = await vscode.window.showOpenDialog({
					title:
						'Test script: exit 0 = good, 1 = bad, 125 = skip; ' +
						'it gets the build directory',
					canSelectMany: false,
					defaultUri: vscode.Uri.file(settings.root),
				});
				if (uri) {
					await bisect.run(uri[0].fsPath);
				}
			},
		],
		[
			'kernelWorkbench.bisect.copyFixes',
			async () => {
				if (!bisect.result) {
					return;
				}
				const line = await fixesLine(bisect.root, bisect.result.hash);
				await vscode.env.clipboard.writeText(line);
				vscode.window.showInformationMessage(`Copied: ${line}`);
			},
		],
	];
	const view = vscode.window.createTreeView('kernelWorkbench.bisect', { treeDataProvider: tree });
	for (const [id, fn] of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	}
	context.subscriptions.push(
		view,
		view.onDidChangeVisibility(() => view.visible && bisect.refresh()),
	);
	bisect.refresh();
	return { bisect, view: tree };
}
