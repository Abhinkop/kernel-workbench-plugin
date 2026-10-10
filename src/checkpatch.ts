import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { git, lineInWorkingTree } from './git';

/** One checkpatch finding. */
export interface Finding {
	level: 'ERROR' | 'WARNING' | 'CHECK';
	/** The checkpatch type, e.g. SPACING (--show-types). */
	type: string;
	message: string;
	/** Relative to the tree; absent for commit-message findings. */
	file?: string;
	/** 1-based, in the checked version of the file. */
	line?: number;
}

export interface Report {
	findings: Finding[];
	errors: number;
	warnings: number;
	checks: number;
	/** checkpatch's raw output. */
	output: string;
}

/**
 * Types about the commit message or its tags rather than the code. With --showfile
 * checkpatch still attaches some of them to a file and line (the last hunk), which would
 * put them on the wrong source line.
 */
export const COMMIT_TYPES = new Set([
	'MISSING_SIGN_OFF',
	'BAD_SIGN_OFF',
	'NO_AUTHOR_SIGN_OFF',
	'FROM_SIGN_OFF_MISMATCH',
	'COMMIT_MESSAGE',
	'COMMIT_LOG_LONG_LINE',
	'COMMIT_LOG_VERSIONING',
	'COMMIT_LOG_WRONG_LINK',
	'COMMIT_COMMENT_SYMBOL',
	'GERRIT_CHANGE_ID',
	'BAD_FIXES_TAG',
	'UNKNOWN_COMMIT_ID',
	'GIT_COMMIT_ID',
	'EMAIL_SUBJECT',
	'BAD_REPORTED_BY_LINK',
	'BAD_STABLE_ADDRESS_STYLE',
	'DIFF_IN_COMMIT_MSG',
	'MISSING_FIXES_TAG',
	'BAD_COMMIT_SEPARATOR',
	'COMMIT_LOG_USE_LINK',
	'FILE_PATH_CHANGES',
]);

/** The report in checkpatch --terse --showfile --show-types output. */
export function parse(out: string): Report {
	const findings: Finding[] = [];
	for (const line of out.split('\n')) {
		const m = /^(.*?):(\d+): (ERROR|WARNING|CHECK):([A-Z0-9_]+): (.*)$/.exec(line);
		if (!m) {
			continue;
		}
		const [, file, lineNo, level, type, message] = m;
		const commitLevel = !file || file === '-' || COMMIT_TYPES.has(type);
		findings.push({
			level: level as Finding['level'],
			type,
			message,
			...(commitLevel ? {} : { file, line: +lineNo }),
		});
	}
	const count = (level: string) => findings.filter(f => f.level === level).length;
	return {
		findings,
		errors: count('ERROR'),
		warnings: count('WARNING'),
		checks: count('CHECK'),
		output: out,
	};
}

/** checkpatch's arguments from the settings. */
function options(root: string): string[] {
	const cfg = vscode.workspace.getConfiguration('kernelWorkbench', vscode.Uri.file(root));
	const args = ['--terse', '--showfile', '--show-types', '--color=never'];
	if (cfg.get('checkpatch.strict', false)) {
		args.push('--strict');
	}
	const ignore = cfg.get<string[]>('checkpatch.ignore', []);
	if (ignore.length) {
		args.push(`--ignore=${ignore.join(',')}`);
	}
	return args;
}

/**
 * Runs scripts/checkpatch.pl. It exits non-zero when it finds problems, which is not a
 * failure here.
 */
function run(root: string, args: string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			'perl',
			[path.join(root, 'scripts', 'checkpatch.pl'), ...args],
			{ cwd: root, maxBuffer: 64 << 20 },
			(error, stdout, stderr) => {
				if (error && !stdout && stderr) {
					reject(new Error(stderr.trim().split('\n').slice(0, 3).join('\n')));
				} else {
					resolve(stdout);
				}
			},
		);
		if (input !== undefined && child.stdin) {
			child.stdin.end(input);
		}
	});
}

/** Checks the uncommitted changes (staged and unstaged, against HEAD); undefined: none. */
export async function checkWorkingChanges(root: string): Promise<Report | undefined> {
	const diff = await git(root, ['diff', 'HEAD', '--no-color']);
	if (!diff.trim()) {
		return undefined;
	}
	return parse(await run(root, [...options(root), '--no-signoff', '-'], diff));
}

export async function checkCommit(root: string, commit: string): Promise<Report> {
	return parse(await run(root, [...options(root), '--git', commit]));
}

interface Placed {
	file: string;
	line: number;
	finding: Finding;
	origin: string;
}

/**
 * Publishes findings to the Problems panel, keeping the working-changes results and the
 * series results apart so that re-running one does not wipe the other.
 */
export class Problems {
	readonly collection = vscode.languages.createDiagnosticCollection('checkpatch');
	/** The placed findings, by origin: 'working' or a commit hash. */
	private readonly byOrigin = new Map<string, Placed[]>();

	constructor(private readonly root: string) {}

	/**
	 * Sets an origin's findings; `rev`: the revision their line numbers are in, mapped to the
	 * working tree.
	 */
	async set(origin: string, findings: Finding[], rev?: string): Promise<void> {
		const placed: Placed[] = [];
		for (const finding of findings) {
			if (!finding.file || !finding.line) {
				continue;
			}
			const at = finding.line;
			const line = rev
				? await lineInWorkingTree(this.root, rev, finding.file, at).catch(() => at)
				: at;
			placed.push({ file: finding.file, line, finding, origin });
		}
		this.byOrigin.set(origin, placed);
		this.publish();
	}

	/** Drops the origins `keep` rejects. */
	prune(keep: (origin: string) => boolean): void {
		for (const origin of [...this.byOrigin.keys()]) {
			if (!keep(origin)) {
				this.byOrigin.delete(origin);
			}
		}
		this.publish();
	}

	publish(): void {
		const byFile = new Map<string, vscode.Diagnostic[]>();
		const seen = new Set<string>();
		for (const placed of this.byOrigin.values()) {
			for (const p of placed) {
				// The same problem found in a commit and in the working tree is shown once.
				const key = `${p.file}:${p.line}:${p.finding.type}:${p.finding.message}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				const severity =
					p.finding.level === 'ERROR'
						? vscode.DiagnosticSeverity.Error
						: p.finding.level === 'WARNING'
							? vscode.DiagnosticSeverity.Warning
							: vscode.DiagnosticSeverity.Information;
				const diagnostic = new vscode.Diagnostic(
					new vscode.Range(p.line - 1, 0, p.line - 1, 1000),
					p.finding.message,
					severity,
				);
				diagnostic.source =
					p.origin === 'working' ? 'checkpatch' : `checkpatch ${p.origin.slice(0, 12)}`;
				diagnostic.code = p.finding.type;
				const list = byFile.get(p.file) ?? [];
				list.push(diagnostic);
				byFile.set(p.file, list);
			}
		}
		this.collection.clear();
		for (const [file, list] of byFile) {
			this.collection.set(vscode.Uri.file(path.join(this.root, file)), list);
		}
	}
}
