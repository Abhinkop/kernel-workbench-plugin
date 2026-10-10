import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { archInfo, isNative } from './arch';
import type { Settings } from './settings';
import { runTask, sq } from './tasks';

/** kunit.py --arch names (tools/testing/kunit/qemu_configs/). */
export const KUNIT_ARCH: Record<string, string> = {
	x86_64: 'x86_64',
	arm64: 'arm64',
	riscv64: 'riscv',
};

/**
 * A group in kunit.py --json output: a suite, or a parameterized test whose cases are its
 * parameters.
 */
interface Group {
	name: string;
	sub_groups?: Group[];
	test_cases?: { name: string; status: string }[];
}

/** What kunit.py printed for a failed test, and where the first failed check is. */
export interface Failure {
	log: string;
	file?: string;
	line?: number;
}

/**
 * The failures in kunit.py's output, by test name: the lines printed before each [FAILED],
 * and their first "EXPECTATION/ASSERTION FAILED at file:line".
 */
export function failures(out: string): Map<string, Failure> {
	const map = new Map<string, Failure>();
	let pending: string[] = [];
	for (const raw of out.split('\n')) {
		const line = raw.replace(/^\[\d\d:\d\d:\d\d\] /, '').trim();
		const failed = /^\[FAILED\] (.+)$/.exec(line);
		if (failed) {
			const log = pending.join('\n');
			const at = /(?:EXPECTATION|ASSERTION) FAILED at (\S+?):(\d+)/.exec(log);
			map.set(failed[1], { log, ...(at ? { file: at[1], line: +at[2] } : {}) });
			pending = [];
		} else if (/^\[(PASSED|SKIPPED)\] /.test(line) || /^=+/.test(line)) {
			pending = [];
		} else {
			pending.push(line);
		}
	}
	return map;
}

/** KUnit in the Testing view: kunit.py runs for the selected architecture. */
export class Kunit {
	readonly controller: vscode.TestController;

	constructor(
		context: vscode.ExtensionContext,
		private readonly settings: Settings,
	) {
		this.controller = vscode.tests.createTestController('kernelWorkbenchKunit', 'KUnit');
		this.controller.createRunProfile(
			'Run in QEMU',
			vscode.TestRunProfileKind.Run,
			(request, token) => this.run(request, token),
			true,
		);
		this.controller.refreshHandler = () => this.load();
		context.subscriptions.push(this.controller);
		this.load();
	}

	get arch(): string {
		return this.settings.arch;
	}

	/** kernelWorkbench.kunit.buildDirectory for the architecture, apart from the builds. */
	buildDir(): string {
		const template = this.settings.get('kunit.buildDirectory', 'build/kunit/${arch}');
		return path.resolve(this.settings.root, template.replace(/\$\{arch\}/g, this.arch));
	}

	/** The last run's results, which is how the tests are known. */
	resultsFile(): string {
		return path.join(this.buildDir(), 'kernel-workbench-results.json');
	}

	/** The test items: from the last run's results, since tests are known only after a run. */
	load(): void {
		const rootItem = this.controller.createTestItem('kunit', `KUnit (${this.arch})`);
		rootItem.description = 'run to discover the tests';
		this.controller.items.replace([rootItem]);
		let results: Group;
		try {
			results = JSON.parse(fs.readFileSync(this.resultsFile(), 'utf8'));
		} catch {
			return;
		}
		rootItem.description = '';
		const add = (parent: vscode.TestItem, group: Group, prefix: string) => {
			const id = prefix ? `${prefix}.${group.name}` : group.name;
			const item = this.controller.createTestItem(id, group.name);
			parent.children.add(item);
			for (const sub of group.sub_groups ?? []) {
				add(item, sub, id);
			}
			for (const test of group.test_cases ?? []) {
				item.children.add(this.controller.createTestItem(`${id}.${test.name}`, test.name));
			}
		};
		for (const group of results.sub_groups ?? []) {
			add(rootItem, group, '');
		}
	}

	/**
	 * kunit.py run for the selected architecture and toolchain, its output also in `log`;
	 * `filter`: a --filter_glob, `kunitconfig`: instead of kernelWorkbench.kunit.kunitconfig.
	 */
	command(filter: string | undefined, kunitconfig: string | undefined, log: string): string {
		const args = [
			'python3',
			'tools/testing/kunit/kunit.py',
			'run',
			`--arch=${KUNIT_ARCH[this.arch]}`,
			`--build_dir=${this.buildDir()}`,
			`--jobs=${this.settings.jobs().slice(2)}`,
			`--json=${this.resultsFile()}.new`,
		];
		if (this.settings.get('toolchain', 'gcc') === 'llvm') {
			args.push('--make_options=LLVM=1');
		} else if (!isNative(this.arch)) {
			const prefixes = this.settings.get<Record<string, string>>('crossCompile', {});
			args.push(`--cross_compile=${prefixes[this.arch] ?? archInfo(this.arch).gccPrefix}`);
		}
		const config = kunitconfig || this.settings.get('kunit.kunitconfig', '');
		if (config) {
			args.push(`--kunitconfig=${config}`);
		}
		if (filter) {
			args.push(filter);
		}
		return `set -o pipefail; ${args.map(sq).join(' ')} 2>&1 | tee ${sq(log)}`;
	}

	/** Runs the requested tests and reports the results, keeping the other suites' results. */
	async run(
		request: vscode.TestRunRequest,
		_token: vscode.CancellationToken,
		kunitconfig?: string,
	): Promise<void> {
		const run = this.controller.createTestRun(request);
		// One filter glob: a single suite or test when exactly one is requested, otherwise
		// everything (results are then reported for the requested items only).
		const include = request.include ?? [];
		const one = include.length === 1 && include[0].id !== 'kunit' ? include[0].id : undefined;
		const filter = one
			? one.split('.').length === 1
				? one
				: one.split('.').slice(0, 2).join('.')
			: undefined;
		fs.mkdirSync(this.buildDir(), { recursive: true });
		const log = path.join(this.buildDir(), 'kernel-workbench-output.log');
		const code = await runTask(
			this.settings.folder,
			`KUnit ${this.arch}${filter ? ` ${filter}` : ''}`,
			'bash',
			['-c', this.command(filter, kunitconfig, log)],
			{ step: 'kunit' },
		);
		let out = '';
		try {
			out = fs.readFileSync(log, 'utf8');
		} catch {
			// no output at all
		}
		const fresh = `${this.resultsFile()}.new`;
		if (!fs.existsSync(fresh)) {
			run.appendOutput(out.replace(/\n/g, '\r\n'));
			for (const item of include.length ? include : [...this.all()]) {
				run.errored(
					item,
					new vscode.TestMessage(
						`kunit.py did not produce results (exit ${code}); see the KUnit terminal.`,
					),
				);
			}
			run.end();
			return;
		}
		// Merge into the known results so that a filtered run keeps the others.
		const results: Group = JSON.parse(fs.readFileSync(fresh, 'utf8'));
		fs.rmSync(fresh, { force: true });
		if (!filter || !fs.existsSync(this.resultsFile())) {
			fs.writeFileSync(this.resultsFile(), JSON.stringify(results));
		} else {
			const known: Group = JSON.parse(fs.readFileSync(this.resultsFile(), 'utf8'));
			known.sub_groups ??= [];
			for (const group of results.sub_groups ?? []) {
				const i = known.sub_groups.findIndex(k => k.name === group.name);
				if (i >= 0) {
					known.sub_groups.splice(i, 1, group);
				} else {
					known.sub_groups.push(group);
				}
			}
			fs.writeFileSync(this.resultsFile(), JSON.stringify(known));
		}
		this.load();
		const why = failures(out);
		const wanted = (item: vscode.TestItem) =>
			!include.length ||
			include.some(
				i => i.id === 'kunit' || item.id === i.id || item.id.startsWith(`${i.id}.`),
			);
		const report = (group: Group, prefix: string) => {
			const id = prefix ? `${prefix}.${group.name}` : group.name;
			for (const sub of group.sub_groups ?? []) {
				report(sub, id);
			}
			for (const test of group.test_cases ?? []) {
				const item = this.find(`${id}.${test.name}`);
				if (!item || !wanted(item)) {
					continue;
				}
				if (test.status === 'PASS') {
					run.passed(item);
				} else if (test.status === 'SKIP') {
					run.skipped(item);
				} else {
					const failure = why.get(test.name);
					const message = new vscode.TestMessage(failure?.log.trim() || test.status);
					if (failure?.file && failure.line) {
						message.location = new vscode.Location(
							vscode.Uri.file(path.join(this.settings.root, failure.file)),
							new vscode.Range(failure.line - 1, 0, failure.line - 1, 0),
						);
					}
					run.failed(item, message);
				}
			}
		};
		for (const group of results.sub_groups ?? []) {
			report(group, '');
		}
		run.end();
	}

	find(id: string): vscode.TestItem | undefined {
		for (const item of this.all()) {
			if (item.id === id) {
				return item;
			}
		}
		return undefined;
	}

	/** Every test item, depth first. */
	*all(): Generator<vscode.TestItem> {
		const stack: vscode.TestItem[] = [];
		this.controller.items.forEach(item => stack.push(item));
		while (stack.length) {
			const item = stack.pop() as vscode.TestItem;
			yield item;
			item.children.forEach(child => stack.push(child));
		}
	}
}

/** The Testing view's KUnit controller, and Run KUnit Tests for This Directory. */
export function registerKunit(context: vscode.ExtensionContext, settings: Settings): Kunit {
	const kunit = new Kunit(context, settings);
	context.subscriptions.push(
		settings.onDidChange(() => kunit.load()),
		vscode.commands.registerCommand(
			'kernelWorkbench.kunit.runDirectory',
			async (uri?: vscode.Uri) => {
				const target = uri ?? vscode.window.activeTextEditor?.document.uri;
				if (!target) {
					return;
				}
				const isDir =
					fs.existsSync(target.fsPath) && fs.statSync(target.fsPath).isDirectory();
				let dir = isDir ? target.fsPath : path.dirname(target.fsPath);
				// The nearest .kunitconfig up the tree.
				while (
					dir.startsWith(settings.root) &&
					!fs.existsSync(path.join(dir, '.kunitconfig'))
				) {
					dir = path.dirname(dir);
				}
				if (!fs.existsSync(path.join(dir, '.kunitconfig'))) {
					vscode.window.showWarningMessage(
						'Kernel: no .kunitconfig in this directory or above it.',
					);
					return;
				}
				await kunit.run(
					new vscode.TestRunRequest(),
					new vscode.CancellationTokenSource().token,
					path.relative(settings.root, dir),
				);
			},
		),
	);
	return kunit;
}
