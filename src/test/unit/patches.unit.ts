// Patch generation: recipients from get_maintainer.pl and an editor tab, the cover letter
// as the branch description, the subject prefix, and git format-patch with its guards.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
	answer,
	events,
	extensionContext,
	state,
	textDocument,
	vscode,
	workspaceFolder,
} from '../helpers/vscode';
import { makeRepo, tempDir } from '../helpers/repo';
import { COVER_TEMPLATE, splitRecipients } from '../../patches';
import { registerSeries } from '../../series';
import { Settings } from '../../settings';

/** A tree with a branch of two commits over master, and stand-in kernel scripts. */
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
	r.write(
		'scripts/get_maintainer.pl',
		[
			'#!/usr/bin/perl',
			'print "Maint One <one\\@example.com> (maintainer:FOO DRIVER)\\n";',
			'print "Rev Two <two\\@example.com> (reviewer:FOO DRIVER)\\n";',
			'print "foo-list\\@vger.kernel.org (open list:FOO DRIVER)\\n";',
			'print "Someone <s\\@example.com> (commit_signer:3/4=75%)\\n";',
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
	state.config['kernelWorkbench.patches.outputDirectory'] = path.join(
		tempDir(),
		'${branch}/v${version}',
	);
	return { r, c1, c2, settings, context };
}

const wait = async (condition: () => boolean, ms = 5000) => {
	for (let t = 0; t < ms && !condition(); t += 20) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
};

const lastWarning = () => String(state.log.filter(l => l.kind === 'warning').pop()?.message);

describe('patches', () => {
	it('splits get_maintainer.pl output into To and Cc', () => {
		const { to, cc } = splitRecipients(
			[
				'Maint One <one@example.com> (maintainer:FOO)',
				'Rev Two <two@example.com> (reviewer:FOO)',
				'list@vger.kernel.org (open list:FOO)',
				'Signer <s@example.com> (commit_signer:3/4=75%)',
				'no address here',
			].join('\n'),
		);
		assert.deepEqual(to, ['Maint One <one@example.com>', 'Rev Two <two@example.com>']);
		assert.deepEqual(cc, ['list@vger.kernel.org', 'Signer <s@example.com>']);
	});

	it('lists the patch settings and actions in the Series view', async () => {
		const { r, context, settings } = seriesTree();
		try {
			const { series, view } = registerSeries(context, settings);
			await series.refresh();
			await view.refresh();
			const rows = view.getChildren();
			assert.ok(rows.map(i => i.label).includes('Patches'));
			const actions = view.getChildren(rows[0]).map(i => i.label);
			assert.deepEqual(actions.slice(2), ['Fill recipients', 'Generate patches']);
			const patches = rows.find(i => i.label === 'Patches');
			assert.deepEqual(
				view.getChildren(patches).map(i => [i.label, i.description]),
				[
					['Subject prefix', '[PATCH]'],
					['Cover letter', 'not written yet'],
					['To', '0'],
					['Cc', '0'],
				],
			);
			assert.equal(
				view.getChildren(patches)[0].command?.command,
				'kernelWorkbench.series.editPrefix',
			);
		} finally {
			r.remove();
		}
	});

	it('fills and edits recipients, edits the cover letter and the prefix', async () => {
		const { r, context, settings } = seriesTree();
		try {
			const { series, patches } = registerSeries(context, settings);
			await series.refresh();
			await patches.fillRecipients();
			assert.deepEqual(patches.to, [
				'Maint One <one@example.com>',
				'Rev Two <two@example.com>',
			]);
			assert.deepEqual(patches.cc, ['foo-list@vger.kernel.org', 'Someone <s@example.com>']);

			await patches.editRecipients();
			const file = [...patches.recipientFiles][0];
			assert.match(
				fs.readFileSync(file, 'utf8'),
				/^To:\nMaint One <one@example.com>\nRev Two/m,
			);
			events.onDidSaveTextDocument.fire(
				textDocument(vscode.Uri.file(file), '# c\nTo:\na@x.org,\n\nCc:\nb@x.org\n'),
			);
			await wait(() => patches.cc[0] === 'b@x.org');
			assert.deepEqual([patches.to, patches.cc], [['a@x.org'], ['b@x.org']]);

			assert.equal(await patches.cover(), '');
			await patches.editCover();
			const cover = [...patches.editing.keys()][0];
			assert.equal(fs.readFileSync(cover, 'utf8'), COVER_TEMPLATE.trimEnd() + '\n');
			events.onDidSaveTextDocument.fire(
				textDocument(vscode.Uri.file(cover), 'foo: the subject\n\nThe body.\n'),
			);
			await wait(() => r.git('config', '--get', 'branch.topic.description').trim() !== '');
			assert.equal(await patches.cover(), 'foo: the subject\n\nThe body.');

			answer('RFC PATCH net-next');
			await patches.editPrefix();
			assert.equal(patches.prefix, 'RFC PATCH net-next');
		} finally {
			r.remove();
		}
	});

	it('generates the series with git format-patch', async () => {
		const { r, c1, context, settings } = seriesTree();
		try {
			const { series, patches } = registerSeries(context, settings);
			await series.refresh();
			r.git('config', 'branch.topic.description', 'foo: two files\n\nAdds a.c and b.c.');
			await patches.set('to', ['one@example.com']);
			await patches.set('cc', ['list@example.com']);
			await series.setVersion(2);
			await patches.generate();
			assert.ok(patches.output);
			assert.deepEqual(patches.output.files, [
				'v2-0000-cover-letter.patch',
				'v2-0001-foo-add-a.c.patch',
				'v2-0002-foo-add-b.c.patch',
			]);
			const read = (i: number) =>
				fs.readFileSync(path.join(patches.output!.dir, patches.output!.files[i]), 'utf8');
			const cover = read(0);
			assert.match(cover, /^Subject: \[PATCH v2 0\/2\] foo: two files$/m);
			assert.match(cover, /^To: one@example.com$/m);
			assert.match(cover, /^Cc: list@example.com$/m);
			assert.match(cover, /^base-commit: [0-9a-f]{40}$/m);
			assert.match(read(1), new RegExp(`^From ${c1}`));
			assert.match(String(state.shown.pop()?.uri), /v2-0000-cover-letter\.patch$/);
			// Regenerating asks before replacing.
			answer(undefined);
			await patches.generate();
			assert.match(lastWarning(), /already has 3 patch files/);
		} finally {
			r.remove();
		}
	});

	it('stops on checkpatch errors and a missing cover letter unless told to go on', async () => {
		const { r, context, settings } = seriesTree({ checkpatchErrors: 1 });
		try {
			const { patches } = registerSeries(context, settings);
			// assert narrows the property; read it through a function instead.
			const output = () => patches.output;
			answer(undefined);
			await patches.generate();
			assert.match(lastWarning(), /checkpatch reports 2 errors in 2 of 2 commits/);
			assert.equal(output(), undefined, 'nothing written');
			answer('Generate Anyway', 'Generate Anyway');
			await patches.generate();
			assert.match(lastWarning(), /cover letter has not been written/);
			assert.equal(output()?.files.length, 3);
			assert.match(
				fs.readFileSync(path.join(output()!.dir, output()!.files[0]), 'utf8'),
				/\*\*\* SUBJECT HERE \*\*\*/,
			);
		} finally {
			r.remove();
		}
	});
});
