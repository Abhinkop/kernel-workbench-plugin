// The Series view: the commits over the base, checkpatch on them and on the working changes,
// the W=1 build check, and the version per branch; and checkpatch's parsing and placement.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { answer, extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { makeRepo, tempDir } from '../helpers/repo';
import * as checkpatch from '../../checkpatch';
import { registerSeries, statusIcon, summary } from '../../series';
import { Settings } from '../../settings';
import type { Configured } from '../../settings';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** A tree with a branch of two commits over master, and a checkpatch stand-in. */
function seriesTree({ checkpatchErrors = 0 } = {}) {
	const r = makeRepo();
	r.write(
		'scripts/checkpatch.pl',
		[
			'#!/usr/bin/perl',
			"my $git = grep { $_ eq '--git' } @ARGV;",
			checkpatchErrors ? 'print "a.c:1: ERROR:SPACING: bad spacing\\n";' : '',
			'print ":3: WARNING:COMMIT_LOG_LONG_LINE: long line\\n" if $git;',
			'',
		].join('\n'),
	);
	r.commit('scripts: add stand-ins');
	r.git('branch', 'base');
	r.git('checkout', '-q', '-b', 'topic');
	const c1 = r.commit('foo: add a.c', { 'a.c': 'int a;\n' });
	const c2 = r.commit('foo: add b.c', { 'b.c': 'int b;\n' });
	const context = extensionContext();
	const settings = new Settings(context, workspaceFolder(r.dir));
	settings.configured = () => undefined;
	state.config['kernelWorkbench.patches.base'] = 'base';
	return { r, c1, c2, settings, context };
}

describe('checkpatch', () => {
	it('parses findings and keeps commit-message ones off source lines', () => {
		const report = checkpatch.parse(
			[
				'drivers/x.c:57: WARNING:SPACING: space prohibited before semicolon',
				'drivers/x.c:65: ERROR:MISSING_SIGN_OFF: Missing Signed-off-by: line(s)',
				':12: WARNING:COMMIT_LOG_LONG_LINE: Prefer a maximum 75 chars per line',
				'drivers/x.c:3: CHECK:PARENTHESIS_ALIGNMENT: ' +
					'Alignment should match open parenthesis',
				'total: 1 errors, 2 warnings, 1 checks, 7 lines checked',
			].join('\n'),
		);
		assert.deepEqual([report.errors, report.warnings, report.checks], [1, 2, 1]);
		assert.deepEqual(
			report.findings.map(f => [f.type, f.file, f.line]),
			[
				['SPACING', 'drivers/x.c', 57],
				['MISSING_SIGN_OFF', undefined, undefined],
				['COMMIT_LOG_LONG_LINE', undefined, undefined],
				['PARENTHESIS_ALIGNMENT', 'drivers/x.c', 3],
			],
		);
	});

	it("runs the tree's checkpatch with the configured options and places findings", async () => {
		const r = makeRepo();
		try {
			const c = r.commit('x: add', { 'x.c': lines(10) });
			r.write(
				'scripts/checkpatch.pl',
				'#!/usr/bin/perl\nprint "ARGS @ARGV\\n"; ' +
					'print "x.c:3: ERROR:TRAILING_WHITESPACE: trailing whitespace\\n";\n',
			);
			state.config['kernelWorkbench.checkpatch.strict'] = true;
			state.config['kernelWorkbench.checkpatch.ignore'] = ['FILE_PATH_CHANGES', 'SPDX'];
			const report = await checkpatch.checkCommit(r.dir, c);
			assert.match(
				report.output,
				new RegExp(
					'ARGS --terse --showfile --show-types --color=never --strict ' +
						'--ignore=FILE_PATH_CHANGES,SPDX --git [0-9a-f]+',
				),
			);
			assert.equal(await checkpatch.checkWorkingChanges(r.dir), undefined, 'no changes');
			r.write('x.c', 'two\nnew\nlines\n' + lines(10));
			const working = await checkpatch.checkWorkingChanges(r.dir);
			assert.ok(working);
			assert.match(working.output, /--no-signoff -/);
			const problems = new checkpatch.Problems(r.dir);
			await problems.set(c, report.findings, c);
			await problems.set('working', working.findings);
			const key = `checkpatch|${vscode.Uri.file(path.join(r.dir, 'x.c')).toString()}`;
			const placed = state.diagnostics.get(key) as {
				range: { start: { line: number } };
				source: string;
			}[];
			assert.deepEqual(
				placed.map(d => [d.range.start.line + 1, d.source]).sort(),
				[
					[3, 'checkpatch'],
					[6, `checkpatch ${c.slice(0, 12)}`],
				],
				'line 3 of the commit is line 6 now',
			);
			problems.prune(origin => origin === 'working');
			assert.equal((state.diagnostics.get(key) as unknown[]).length, 1);
		} finally {
			r.remove();
		}
	});
});

describe('series', () => {
	it('finds the commits over the base, and asks for a base when there is none', async () => {
		const { r, c1, c2, context, settings } = seriesTree();
		try {
			const { series, view } = registerSeries(context, settings);
			await series.refresh();
			assert.equal(series.info.branch, 'topic');
			assert.equal(series.info.base, 'base');
			assert.deepEqual(
				series.info.commits.map(c => c.hash),
				[c1, c2],
			);
			assert.deepEqual(
				view.getChildren().map(i => i.label),
				['Actions', 'Base', 'Version', 'Commits', 'Working changes', 'Check options'],
			);
			const [actions, base] = view.getChildren();
			assert.deepEqual(
				view.getChildren(actions).map(i => [i.label, i.command?.command]),
				[
					['Check series', 'kernelWorkbench.series.check'],
					['Check working changes', 'kernelWorkbench.series.checkWorking'],
				],
			);
			assert.equal(base.command?.command, 'kernelWorkbench.series.pickBase', 'a click picks');
			assert.equal(view.view?.description, 'topic · v1');

			state.config['kernelWorkbench.patches.base'] = 'no-such-ref';
			await series.refresh();
			assert.ok(!series.info.mergeBase);
			assert.match(String(series.info.error), /does not exist here/);
			assert.deepEqual(view.getChildren(), [], 'the welcome view shows instead');
			const noBase = state.executed.filter(
				e => e.id === 'setContext' && e.args[0] === 'kernelWorkbench.seriesNoBase',
			);
			assert.equal(noBase.pop()?.args[1], true);
			answer((items: string[]) => items.find(i => i === 'master'));
			await series.pickBase();
			assert.equal(series.info.base, 'master');
		} finally {
			r.remove();
		}
	});

	it('checks every commit and the working changes', async () => {
		const { r, c1, context, settings } = seriesTree();
		try {
			const { series, view } = registerSeries(context, settings);
			await series.checkSeries();
			assert.equal(series.reports.size, 2);
			assert.equal(series.reports.get(c1)?.warnings, 1);
			assert.equal(series.lastBuild, 'skipped: configure a build in the Kernel tab for W=1');
			const commits = view.getChildren().find(i => i.label === 'Commits');
			const first = commits?.children?.[0];
			assert.ok(first);
			assert.equal(first.description, '1/2 · 1 warning');
			assert.equal((first.iconPath as { id: string }).id, 'warning');
			assert.match(String((first.tooltip as { value: string }).value), /long line/);
			assert.equal(first.contextValue, 'commitChecked');
			const working = () => series.working;
			await series.checkWorking();
			assert.equal(working(), null, 'no uncommitted changes');
			r.write('a.c', 'int a ;\n');
			await series.checkWorking();
			assert.equal(working()?.errors, 0);
			await series.showReport(c1);
			assert.match(String(state.shown.pop()?.uri), /^untitled:/);
		} finally {
			r.remove();
		}
	});

	it('compiles the touched C files with W=1 in the configured build', async () => {
		const { r, context, settings } = seriesTree();
		const bin = tempDir();
		const PATH = process.env.PATH;
		try {
			// A make stand-in that warns about a.c.
			fs.writeFileSync(
				path.join(bin, 'make'),
				'#!/bin/sh\necho "MAKE $*"\necho "a.c:1:5: warning: unused variable"\nexit 0\n',
				{ mode: 0o755 },
			);
			process.env.PATH = `${bin}:${PATH}`;
			const buildDir = tempDir();
			const configured: Configured = {
				arch: 'x86_64',
				variant: 'debug',
				config: 'defconfig',
				buildDir,
				makeArgs: [`O=${buildDir}`, 'ARCH=x86_64'],
				configuredAt: new Date().toISOString(),
			};
			settings.configured = () => configured;
			const { series } = registerSeries(context, settings);
			await series.refresh();
			await series.buildChecks(series.info.mergeBase as string);
			assert.equal(series.lastBuild, 'W=1 on 2 files: 0 errors, 1 warnings (see Problems)');
			const task = state.tasks.pop();
			assert.ok(task);
			assert.match(task.name, /^Check build W=1 \(2 files\)$/);
			assert.match(String(task.execution.args[1]), / W=1 a\.o b\.o 2>&1 \| tee /);
			assert.match(task.output, /^MAKE O=\S+ ARCH=x86_64 -j\d+ -k W=1 a\.o b\.o$/m);
		} finally {
			process.env.PATH = PATH;
			r.remove();
		}
	});

	it('summarizes results', () => {
		assert.deepEqual(summary(undefined), { text: 'not checked', cls: '' });
		assert.deepEqual(summary(null), { text: 'no changes', cls: '' });
		const report = (errors: number, warnings: number, checks: number) => ({
			errors,
			warnings,
			checks,
			findings: [],
			output: '',
		});
		assert.deepEqual(summary(report(2, 1, 0)), { text: '2 errors, 1 warning', cls: 'error' });
		assert.deepEqual(summary(report(0, 0, 0)), { text: 'clean', cls: 'ok' });
		assert.equal(statusIcon(report(1, 0, 0)).icon, 'error');
		assert.equal(statusIcon(report(0, 0, 1)).icon, 'warning');
		assert.equal(statusIcon(undefined).icon, 'git-commit');
	});

	it('keeps the version per branch', async () => {
		const { r, context, settings } = seriesTree();
		try {
			const { series } = registerSeries(context, settings);
			await series.refresh();
			assert.equal(series.version, 1);
			await vscode.commands.executeCommand('kernelWorkbench.series.nextVersion');
			assert.equal(series.version, 2);
			await vscode.commands.executeCommand('kernelWorkbench.series.previousVersion');
			await vscode.commands.executeCommand('kernelWorkbench.series.previousVersion');
			assert.equal(series.version, 1, 'never below v1');
		} finally {
			r.remove();
		}
	});
});
