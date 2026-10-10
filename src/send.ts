import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { gitStatus } from './git';
import type { Patches } from './patches';

/** One mail as git send-email --dry-run reports it. */
export interface DryMail {
	subject: string;
	recipients: string[];
}

/**
 * Sending a generated series with git send-email: always a dry run first; the real send is
 * only offered for exactly the files that dry run covered, after one confirmation, in a
 * terminal (SMTP may ask for a password).
 */
export class Sender {
	readonly root: string;
	/** The last dry run: of which files, what it would send, and whether it succeeded. */
	dry: { fingerprint: string; mails: DryMail[]; ok: boolean } | undefined;
	/** A one-line account of the SMTP setup. */
	smtp = '';

	constructor(readonly patches: Patches) {
		this.root = patches.root;
	}

	/** The files of the last generated series, in order. */
	files(): string[] {
		const output = this.patches.output;
		if (!output) {
			return [];
		}
		return output.files.map(f => path.join(output.dir, f)).filter(f => fs.existsSync(f));
	}

	/** Changes when any file is regenerated or edited. */
	fingerprint(files: string[]): string {
		return files.map(f => `${f}:${fs.statSync(f).mtimeMs}:${fs.statSync(f).size}`).join('|');
	}

	/** The SMTP setup, from git config (read only). */
	async checkConfig(): Promise<string> {
		const get = async (key: string) =>
			(await gitStatus(this.root, ['config', '--get', key])).stdout.trim();
		const server = await get('sendemail.smtpServer');
		const user = await get('sendemail.smtpUser');
		const port = await get('sendemail.smtpServerPort');
		const encryption = await get('sendemail.smtpEncryption');
		this.smtp = server
			? `${user ? `${user} @ ` : ''}${server}${port ? `:${port}` : ''}` +
				(encryption ? ` (${encryption})` : '')
			: 'no sendemail.smtpServer: git send-email would use the local sendmail program';
		return this.smtp;
	}

	/** git send-email --dry-run on the generated files; shows every mail. */
	async dryRun(): Promise<void> {
		const files = this.files();
		if (!files.length) {
			vscode.window.showErrorMessage('Kernel: generate the patches first.');
			return;
		}
		const result = await gitStatus(this.root, [
			'send-email',
			'--dry-run',
			'--confirm=never',
			'--suppress-cc=self',
			...files,
		]);
		if (/is not a git command/.test(result.stderr)) {
			this.dry = undefined;
			vscode.window.showErrorMessage(
				'Kernel: git send-email is not installed ' +
					'(Debian/Ubuntu: sudo apt install git-email).',
			);
			return;
		}
		const mails = parseDryRun(result.stdout);
		const ok = result.code === 0 && mails.length === files.length;
		this.dry = { fingerprint: this.fingerprint(files), mails, ok };
		await this.checkConfig();
		const summary = [
			`git send-email --dry-run: ${ok ? 'OK' : 'FAILED'}, ` +
				`${mails.length} of ${files.length} mails`,
			`SMTP: ${this.smtp}`,
			'',
			...mails.map(
				(m, i) =>
					`${i + 1}. ${m.subject}\n   to ${m.recipients.length}: ` +
					m.recipients.join(', '),
			),
			'',
			'----- full output -----',
			result.stdout,
			result.stderr,
		].join('\n');
		const document = await vscode.workspace.openTextDocument({
			content: summary,
			language: 'plaintext',
		});
		await vscode.window.showTextDocument(document, { preview: true });
		this.patches.series.changed();
	}

	/** Whether the last dry run covers exactly the current files. */
	dryRunCurrent(): boolean {
		const files = this.files();
		return !!(this.dry?.ok && files.length && this.dry.fingerprint === this.fingerprint(files));
	}

	/** Sends for real, after a confirmation, in a terminal. */
	async send(): Promise<void> {
		const files = this.files();
		if (!this.dryRunCurrent() || !this.dry) {
			vscode.window.showErrorMessage('Kernel: run a dry run of these exact files first.');
			return;
		}
		const everyone = new Set(this.dry.mails.flatMap(m => m.recipients));
		const pick = await vscode.window.showWarningMessage(
			`Send ${files.length} mail${files.length > 1 ? 's' : ''} ` +
				`to ${everyone.size} address${everyone.size > 1 ? 'es' : ''}?`,
			{
				modal: true,
				detail:
					`${this.dry.mails[0]?.subject ?? ''}\nvia ${this.smtp}\n\n` +
					'Sent mail cannot be taken back.',
			},
			'Send',
		);
		if (pick !== 'Send') {
			return;
		}
		const terminal = vscode.window.createTerminal({
			name: 'git send-email',
			cwd: this.root,
			shellPath: 'git',
			shellArgs: ['send-email', '--confirm=never', '--suppress-cc=self', ...files],
		});
		terminal.show();
		this.dry = undefined; // a new send needs a new dry run
		this.patches.series.changed();
	}
}

/** The mails in git send-email --dry-run output: each Dry-OK block's recipients and subject. */
export function parseDryRun(out: string): DryMail[] {
	return out
		.split(/^Dry-OK\. Log says:$/m)
		.slice(1)
		.map(block => ({
			subject: (/^Subject: (.*)$/m.exec(block)?.[1] ?? '').trim(),
			recipients: [...block.matchAll(/^RCPT TO:<([^>]+)>$/gm)].map(m => m[1]),
		}));
}
