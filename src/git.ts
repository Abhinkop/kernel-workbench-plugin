import { execFile, spawn } from 'child_process';
import * as path from 'path';

/** Something whose cancellation kills the git process (a CancellationToken). */
export interface Cancel {
	onCancellationRequested(listener: () => void): unknown;
}

export interface GitOptions {
	cancel?: Cancel;
	input?: string;
	env?: Record<string, string>;
}

/**
 * Runs git in the kernel tree and resolves with its stdout; rejects with the first lines of
 * its stderr when it fails. `cancel` kills the process.
 */
export function git(root: string, args: string[], options: GitOptions = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			'git',
			args,
			{
				cwd: root,
				maxBuffer: 512 << 20,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env ?? {}) },
			},
			(error, stdout, stderr) => {
				if (error) {
					const lines = (stderr || error.message).trim().split('\n');
					reject(new Error(lines.slice(0, 4).join('\n')));
				} else {
					resolve(stdout);
				}
			},
		);
		if (options.input !== undefined && child.stdin) {
			child.stdin.end(options.input);
		}
		options.cancel?.onCancellationRequested(() => child.kill());
	});
}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Like git(), but resolves with the exit code and both outputs instead of rejecting, for
 * commands whose exit code carries meaning.
 */
export function gitStatus(
	root: string,
	args: string[],
	options: Omit<GitOptions, 'cancel'> = {},
): Promise<GitResult> {
	return new Promise(resolve => {
		const child = spawn('git', args, {
			cwd: root,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env ?? {}) },
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', data => (stdout += data));
		child.stderr.on('data', data => (stderr += data));
		child.on('error', error => resolve({ code: 127, stdout, stderr: String(error) }));
		child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
		child.stdin.end(options.input);
	});
}

/** One commit as log() lists it. */
export interface Commit {
	hash: string;
	short: string;
	subject: string;
	author: string;
	email: string;
	/** ISO 8601 */
	date: string;
	/** The file's path in this commit (a history with --follow). */
	path?: string;
}

const FIELDS = ['%H', '%h', '%s', '%an', '%ae', '%aI'];
const RS = '\x1e';
const FS = '\x1f';

export interface LogOptions {
	/** Limits the log to these paths (after `--`). */
	paths?: string[];
	/** Also returns each commit's file name (--name-only), for --follow. */
	names?: boolean;
	cancel?: Cancel;
}

/** git log with a parseable format; `args` go before `--`. */
export async function log(
	root: string,
	args: string[],
	options: LogOptions = {},
): Promise<Commit[]> {
	const out = await git(
		root,
		[
			'log',
			`--format=${RS}${FIELDS.join(FS)}`,
			...(options.names ? ['--name-only'] : []),
			...args,
			...(options.paths ? ['--', ...options.paths] : []),
		],
		{ cancel: options.cancel },
	);
	return out
		.split(RS)
		.slice(1)
		.map(chunk => {
			const [head, ...rest] = chunk.split('\n');
			const [hash, short, subject, author, email, date] = head.split(FS);
			const file = rest
				.map(l => l.trim())
				.filter(Boolean)
				.pop();
			return { hash, short, subject, author, email, date, ...(file ? { path: file } : {}) };
		});
}

/** The kernel's Fixes: tag for a commit: a 12-character hash and the subject. */
export async function fixesLine(root: string, rev: string): Promise<string> {
	const out = await git(root, ['log', '-1', '--abbrev=12', '--format=Fixes: %h ("%s")', rev]);
	return out.trim();
}

/** The repository's git directory: a worktree's own one, not the .git file that names it. */
export async function gitDir(root: string): Promise<string> {
	return (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
}

/** Whether `rev` names a commit. */
export async function exists(root: string, rev: string): Promise<boolean> {
	const result = await gitStatus(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
	return result.code === 0;
}

/** A file's path relative to the tree, with slashes; undefined outside the tree. */
export function relative(root: string, file: string): string | undefined {
	const rel = path.relative(root, file);
	return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
		? rel.split(path.sep).join('/')
		: undefined;
}

/**
 * Maps a line number across a diff (`git diff -U0` between an old and a new version of a
 * file). Lines outside hunks shift by what the hunks before them added or removed; a line
 * inside a hunk maps to the same position in the hunk's other side.
 */
export function mapLine(diff: string, line: number, direction: 'toOld' | 'toNew'): number {
	let shift = 0;
	for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
		const old = { start: +m[1], count: m[2] === undefined ? 1 : +m[2] };
		const neu = { start: +m[3], count: m[4] === undefined ? 1 : +m[4] };
		const [from, to] = direction === 'toOld' ? [neu, old] : [old, neu];
		// The first line after the hunk on each side; a count of 0 means the hunk sits after
		// line <start> (a pure insertion or deletion).
		const fromNext = from.count ? from.start + from.count : from.start + 1;
		const toNext = to.count ? to.start + to.count : to.start + 1;
		if (line < (from.count ? from.start : fromNext)) {
			break;
		}
		if (line < fromNext) {
			return Math.max(1, to.start + Math.min(line - from.start, Math.max(to.count - 1, 0)));
		}
		shift = toNext - fromNext;
	}
	return Math.max(1, line + shift);
}

/** Where a line of `file` as of `rev` is in the working tree now. */
export async function lineInWorkingTree(
	root: string,
	rev: string,
	file: string,
	line: number,
): Promise<number> {
	const diff = await git(root, ['diff', '-U0', '--no-color', rev, '--', file]);
	return mapLine(diff, line, 'toNew');
}
