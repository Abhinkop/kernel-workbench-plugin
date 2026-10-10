// Applying series: lore links and Message-IDs, subjects from an mbox and from b4's output,
// git am of local patch files with conflicts resolved, skipped or aborted, a new branch at
// the series' base, and fetching with b4.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { answer, extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { makeRepo, Repo, tempDir } from '../helpers/repo';
import { mboxSubjects, messageId, parseB4, registerApply } from '../../apply';
import { Settings } from '../../settings';

/** A tree with a branch of two commits over base. */
function seriesTree() {
	const r = makeRepo();
	r.commit('scripts: add stand-ins', { 'scripts/checkpatch.pl': '#!/usr/bin/perl\nexit 0;\n' });
	r.git('branch', 'base');
	r.git('checkout', '-q', '-b', 'topic');
	r.commit('foo: add a.c', { 'a.c': 'int a;\n' });
	r.commit('foo: add b.c', { 'b.c': 'int b;\n' });
	const context = extensionContext();
	const settings = new Settings(context, workspaceFolder(r.dir));
	return { r, settings, context };
}

/** The patch files of the topic branch, and the tree back at base to apply them to. */
function patchesFor(r: Repo) {
	const out = tempDir();
	r.git('format-patch', '-q', '-o', out, '--base=base', 'base..topic');
	r.git('checkout', '-q', 'base');
	return fs
		.readdirSync(out)
		.sort()
		.map(f => vscode.Uri.file(path.join(out, f)));
}

describe('apply', () => {
	it('understands lore links and Message-IDs', () => {
		for (const s of [
			'https://lore.kernel.org/all/20260917.123-2-a@b.c/',
			'https://patch.msgid.link/20260917.123-2-a@b.c',
			'<20260917.123-2-a@b.c>',
			'https://lore.kernel.org/bpf/20260917.123-2-a@b.c/T/#u',
			'20260917.123-2-a@b.c',
		]) {
			assert.equal(messageId(s), '20260917.123-2-a@b.c', s);
		}
	});

	it('reads subjects from an mbox and from b4 am output', () => {
		const mbox =
			'From x Mon Sep 17 00:00:00 2001\nSubject: [PATCH 1/2] foo: one\n\nbody\n' +
			'From y Mon Sep 17 00:00:00 2001\nSubject: [PATCH 2/2] foo: a long\n subject\n\nbody\n';
		assert.deepEqual(mboxSubjects(mbox), [
			'[PATCH 1/2] foo: one',
			'[PATCH 2/2] foo: a long subject',
		]);
		const b4 = [
			'  \x1b[32m✓\x1b[0m [PATCH v7 1/10] bpf: Make things killable',
			'    + Reviewed-by: John Doe <j@x.org> (✓ DKIM/x.org)',
			'    + Link: https://lore.kernel.org/r/abc',
			'  [PATCH v7 2/10] bpf: Second',
			' Link: https://lore.kernel.org/r/cover@x',
			' Base: using specified base-commit 0123456789abcdef0123456789abcdef01234567',
		].join('\n');
		const fetched = parseB4(b4, '/tmp/s.mbx', 'id@x');
		assert.deepEqual(fetched.patches, [
			'[PATCH v7 1/10] bpf: Make things killable',
			'[PATCH v7 2/10] bpf: Second',
		]);
		assert.deepEqual(fetched.trailers, ['Reviewed-by: John Doe <j@x.org>']);
		assert.equal(fetched.base, '0123456789abcdef0123456789abcdef01234567');
		assert.equal(fetched.link, 'https://lore.kernel.org/r/cover@x');
		assert.equal(
			parseB4(' Base: base-commit 0123456789ab not known, ignoring', 'x', 'y').base,
			undefined,
		);
	});

	it('applies local patch files with git am, and resolves conflicts', async () => {
		const { r, context, settings } = seriesTree();
		try {
			const files = patchesFor(r);
			const { apply, view } = registerApply(context, settings);
			answer(files);
			await apply.openFiles();
			assert.deepEqual(apply.fetched?.patches, [
				'[PATCH 1/2] foo: add a.c',
				'[PATCH 2/2] foo: add b.c',
			]);
			assert.match(
				String(apply.fetched?.baseNote),
				/^base-commit [0-9a-f]{12} from the patches$/,
			);
			await apply.apply('current');
			assert.equal(apply.message, 'Applied 2 patches.');
			assert.equal(r.git('log', '-1', '--format=%s').trim(), 'foo: add b.c');

			// A conflict: base gets a different a.c first.
			r.git('checkout', '-q', '-b', 'conflict', 'base');
			r.commit('local a.c', { 'a.c': 'int local;\n' });
			await apply.apply('current');
			assert.deepEqual([apply.am?.next, apply.am?.last], [1, 2]);
			assert.deepEqual(apply.am?.conflicts, ['a.c']);
			const rows = view.getChildren();
			assert.deepEqual(
				view.getChildren(rows[0]).map(i => i.label),
				['Continue', 'Skip this patch', 'Abort'],
			);
			assert.match(String(rows[1].label), /^git am stopped at patch 1\/2$/);
			await apply.resolve('continue');
			assert.match(String(state.log.pop()?.message), /conflict markers left in a\.c/);
			r.write('a.c', 'int a;\nint local;\n');
			await apply.resolve('continue');
			assert.equal(apply.message, 'All patches applied.');
			assert.equal(apply.am, undefined);

			// Abort restores the branch.
			r.git('checkout', '-q', '-b', 'abort-me', 'base');
			r.commit('local a.c', { 'a.c': 'int other;\n' });
			await apply.apply('current');
			await apply.resolve('abort');
			assert.equal(r.git('log', '-1', '--format=%s').trim(), 'local a.c');
		} finally {
			r.remove();
		}
	});

	it('reads the state of a git am in a worktree, whose .git is a file', async () => {
		const { r, context } = seriesTree();
		try {
			const files = patchesFor(r);
			const wt = path.join(tempDir(), 'wt');
			r.git('worktree', 'add', '--detach', wt, 'base');
			assert.ok(fs.statSync(path.join(wt, '.git')).isFile());
			const w = new Repo(wt);
			w.commit('local a.c', { 'a.c': 'int local;\n' });
			const { apply } = registerApply(context, new Settings(context, workspaceFolder(wt)));
			answer(files);
			await apply.openFiles();
			await apply.apply('current');
			assert.deepEqual(apply.am?.conflicts, ['a.c']);
			await apply.resolve('abort');
			assert.equal(apply.am, undefined);
			assert.equal(w.git('log', '-1', '--format=%s').trim(), 'local a.c');
		} finally {
			r.remove();
		}
	});

	it("applies on a new branch at the series' base", async () => {
		const { r, context, settings } = seriesTree();
		try {
			const files = patchesFor(r);
			r.commit('master moved on', { 'z.c': 'int z;\n' });
			const { apply } = registerApply(context, settings);
			answer(files);
			await apply.openFiles();
			answer('review/foo');
			await apply.apply('newBranch');
			assert.equal(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'review/foo');
			assert.equal(
				r.git('log', '-1', '--format=%s', 'HEAD~2').trim(),
				'scripts: add stand-ins',
				'branched at the base-commit',
			);
		} finally {
			r.remove();
		}
	});

	it('fetches with b4 am, and reports when b4 is missing', async () => {
		const { r, context, settings } = seriesTree();
		const PATH = process.env.PATH;
		try {
			const { apply } = registerApply(context, settings);
			const bin = tempDir();
			fs.writeFileSync(
				path.join(bin, 'b4'),
				[
					'#!/bin/sh',
					'out=$3; shift 3',
					"printf 'From x Mon Sep 17 00:00:00 2001\\n' " +
						"'Subject: [PATCH] foo: fetched\\n\\nbody\\n'" +
						' > "$out/v1_x.mbx"',
					'echo "  [PATCH] foo: fetched"; echo "    + Acked-by: A <a@x.org>"',
					'echo " Base: not specified"; echo "ARGS $*"',
					'',
				].join('\n'),
				{ mode: 0o755 },
			);
			process.env.PATH = `${bin}:${PATH}`;
			await apply.fetch('https://lore.kernel.org/r/123@x.org', { link: true, signoff: true });
			assert.deepEqual(apply.fetched?.patches, ['[PATCH] foo: fetched']);
			assert.deepEqual(apply.fetched?.trailers, ['Acked-by: A <a@x.org>']);
			assert.match(String(apply.fetched?.log), /ARGS -l -s 123@x\.org/);
			// A PATH without b4, but still with bash, which the other tests' tools need.
			const noB4 = tempDir();
			fs.symlinkSync('/bin/bash', path.join(noB4, 'bash'));
			process.env.PATH = noB4;
			await apply.fetch('123@x.org');
			assert.equal(
				apply.message,
				'b4 is not installed (Debian/Ubuntu: sudo apt install b4).',
			);
		} finally {
			process.env.PATH = PATH;
			r.remove();
		}
	});
});
