// Sending a series: the dry run's mails, and the real send only after a dry run of exactly
// these files, confirmed, in a terminal.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { answer, extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { makeRepo, tempDir } from '../helpers/repo';
import { parseDryRun } from '../../send';
import { registerSeries } from '../../series';
import { Settings } from '../../settings';

/** A tree with a branch of one commit over master, and a checkpatch stand-in. */
function seriesTree() {
	const r = makeRepo();
	r.write('scripts/checkpatch.pl', '#!/usr/bin/perl\nexit 0;\n');
	r.commit('scripts: add stand-ins');
	r.git('branch', 'base');
	r.git('checkout', '-q', '-b', 'topic');
	r.commit('foo: add a.c', { 'a.c': 'int a;\n' });
	const context = extensionContext();
	const settings = new Settings(context, workspaceFolder(r.dir));
	settings.configured = () => undefined;
	state.config['kernelWorkbench.patches.base'] = 'base';
	state.config['kernelWorkbench.patches.outputDirectory'] = path.join(
		tempDir(),
		'${branch}/v${version}',
	);
	return { r, settings, context };
}

describe('send', () => {
	const dry = [
		'Dry-OK. Log says:',
		'RCPT TO:<one@example.com>',
		'RCPT TO:<list@example.com>',
		'Subject: [PATCH 0/1] foo',
		'',
		'Result: OK',
		'Dry-OK. Log says:',
		'RCPT TO:<one@example.com>',
		'Subject: [PATCH 1/1] foo: add',
		'Result: OK',
	].join('\n');

	it('parses a dry run', () => {
		assert.deepEqual(parseDryRun(dry), [
			{ subject: '[PATCH 0/1] foo', recipients: ['one@example.com', 'list@example.com'] },
			{ subject: '[PATCH 1/1] foo: add', recipients: ['one@example.com'] },
		]);
	});

	it('sends only after a dry run of exactly these files, after confirming', async () => {
		const { r, context, settings } = seriesTree();
		const bin = tempDir();
		const PATH = process.env.PATH;
		try {
			// A git send-email stand-in on PATH: prints a dry run per file.
			fs.writeFileSync(
				path.join(bin, 'git-send-email'),
				[
					'#!/bin/sh',
					'for f; do case $f in --*) ;; *)',
					'printf "Dry-OK. Log says:\\nRCPT TO:<a@x.org>\\n" \\',
					'"Subject: %s\\nResult: OK\\n" \\',
					'"$(basename $f)"',
					';; esac; done',
					'',
				].join('\n'),
				{ mode: 0o755 },
			);
			process.env.PATH = `${bin}:${PATH}`;
			r.git('config', 'sendemail.smtpServer', 'smtp.example.com');
			const { series, patches, sender, view } = registerSeries(context, settings);
			await series.refresh();
			await patches.generate();
			await sender.send();
			assert.match(
				String(state.log.pop()?.message),
				/run a dry run of these exact files first/,
			);
			await view.refresh();
			const actions = view.getChildren(view.getChildren()[0]).map(i => i.label);
			assert.ok(actions.includes('Dry run') && !actions.includes('Send…'), actions.join());
			await sender.dryRun();
			assert.ok(sender.dry?.ok && sender.dryRunCurrent());
			assert.equal(sender.smtp, 'smtp.example.com');
			assert.match(String(state.shown.pop()?.uri), /^untitled:/);
			await view.refresh();
			assert.ok(view.getChildren(view.getChildren()[0]).some(i => i.label === 'Send…'));
			const dryRow = view.getChildren(view.getChildren().find(i => i.label === 'Patches'));
			assert.equal(dryRow.find(i => i.label === 'Dry run')?.description, 'OK, 1 mails');
			answer(undefined);
			await sender.send();
			assert.equal(state.terminals.length, 0, 'declined: nothing sent');
			answer('Send');
			await sender.send();
			assert.deepEqual((state.terminals[0].options.shellArgs as string[]).slice(0, 3), [
				'send-email',
				'--confirm=never',
				'--suppress-cc=self',
			]);
			assert.ok(!sender.dryRunCurrent(), 'a new send needs a new dry run');
			await sender.dryRun();
			fs.appendFileSync(sender.files()[0], '\n');
			assert.ok(!sender.dryRunCurrent(), 'editing a file invalidates the dry run');
		} finally {
			process.env.PATH = PATH;
			r.remove();
		}
	});
});
