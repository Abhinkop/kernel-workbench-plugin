import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { archInfo } from './arch';
import { git } from './git';
import type { Settings } from './settings';
import { runTask, sq } from './tasks';
import { onPath } from './tools';

const BINDINGS = 'Documentation/devicetree/bindings/';

/**
 * What to check for a set of changed files: the .dtb of every changed .dts, of every .dts
 * that includes a changed .dtsi from its directory, and the changed binding schemas.
 * `karch` is the kbuild ARCH; the files are relative to the tree.
 */
export function targets(
	root: string,
	karch: string,
	files: string[],
): { dtbs: string[]; schemas: string[] } {
	const dtsDir = `arch/${karch}/boot/dts/`;
	const dtbs = new Set<string>();
	const dtb = (dts: string) => dts.slice(dtsDir.length).replace(/\.dts$/, '.dtb');
	for (const f of files.filter(f => f.startsWith(dtsDir))) {
		if (f.endsWith('.dts')) {
			dtbs.add(dtb(f));
		} else if (f.endsWith('.dtsi')) {
			const dir = path.join(root, path.dirname(f));
			const name = path.basename(f);
			let entries: string[] = [];
			try {
				entries = fs.readdirSync(dir).filter(e => e.endsWith('.dts'));
			} catch {
				// no such directory
			}
			for (const e of entries) {
				if (fs.readFileSync(path.join(dir, e), 'utf8').includes(name)) {
					dtbs.add(dtb(path.join(path.dirname(f), e)));
				}
			}
		}
	}
	const schemas = files
		.filter(f => f.startsWith(BINDINGS) && f.endsWith('.yaml'))
		.map(f => f.slice(BINDINGS.length));
	return { dtbs: [...dtbs].sort(), schemas };
}

export interface DtFinding {
	/** Relative to the tree. */
	file: string;
	line: number;
	severity: 'error' | 'warning';
	message: string;
}

/**
 * The findings in dtc, yamllint and dt-schema output:
 *   dtc:    arch/arm64/boot/dts/x/board.dts:12.5-20: Warning (unit_address_vs_reg): /soc/foo: ...
 *   schema: arch/arm64/boot/dts/x/board.dtb: serial@1000 (vendor,uart): compatible: ... invalid
 *   yaml:   Documentation/devicetree/bindings/x.yaml:12:3: [error] ...
 */
export function parse(out: string, root: string, buildDir: string): DtFinding[] {
	const findings: DtFinding[] = [];
	const rel = (f: string) => {
		const abs = path.isAbsolute(f) ? f : path.join(root, f);
		const inTree = abs.startsWith(buildDir)
			? path.join(root, path.relative(buildDir, abs))
			: abs;
		return path.relative(root, inTree);
	};
	for (const line of out.split('\n')) {
		let m = /^(\S+\.dtsi?):(\d+)\.\d+-[\d.]+: (Warning|Error) \(([\w-]+)\): (.*)$/.exec(line);
		if (m) {
			findings.push({
				file: rel(m[1]),
				line: +m[2],
				severity: m[3] === 'Error' ? 'error' : 'warning',
				message: `${m[4]}: ${m[5]}`,
			});
			continue;
		}
		// dtc syntax errors: "Error: /abs/board.dts:20.2-44 Properties must precede subnodes"
		m = /^(Error|Warning): (\S+\.dtsi?):(\d+)\.[\d.-]+ (.*)$/.exec(line);
		if (m) {
			findings.push({
				file: rel(m[2]),
				line: +m[3],
				severity: m[1] === 'Error' ? 'error' : 'warning',
				message: m[4],
			});
			continue;
		}
		m = /^(\S+\.yaml):(\d+):\d+: \[(error|warning)\] (.*)$/.exec(line);
		if (m) {
			const yaml = m;
			// yamllint runs directly and again inside dt_binding_check.
			const seen = findings.some(
				f => f.file === rel(yaml[1]) && f.line === +yaml[2] && f.message === yaml[4],
			);
			if (!seen) {
				findings.push({
					file: rel(m[1]),
					line: +m[2],
					severity: m[3] === 'error' ? 'error' : 'warning',
					message: m[4],
				});
			}
			continue;
		}
		m = /^(\S+)\.dtb: (.*)$/.exec(line);
		if (m && !/^\s/.test(m[2])) {
			// Schema errors name the .dtb; point at the node in the .dts.
			const dts = rel(`${m[1]}.dts`);
			findings.push({
				file: dts,
				line: nodeLine(path.join(root, dts), m[2]),
				severity: 'warning',
				message: m[2],
			});
		}
	}
	return findings;
}

/**
 * The line of the node a schema message is about ("serial@1000 (...): ..." or
 * "/soc/serial@1000: ..."), or 1.
 */
export function nodeLine(file: string, message: string): number {
	if (!fs.existsSync(file)) {
		return 1;
	}
	// Candidates: the last element of a leading node path ("/soc/serial@1000:"), then any
	// node with a unit address the message mentions ("bogus@1000").
	const names: string[] = [];
	const lead = /^\/((?:[\w,@.+-]+\/)*[\w,@.+-]+):/.exec(message);
	if (lead) {
		names.push(lead[1].split('/').pop() ?? '');
	}
	for (const m of message.matchAll(/([A-Za-z][\w,.+-]*@[0-9a-fA-F,]+)/g)) {
		names.push(m[1]);
	}
	const lines = fs.readFileSync(file, 'utf8').split('\n');
	for (const node of names.filter(Boolean)) {
		const re = new RegExp(`(^|[\\s:&])${node.replace(/[.+]/g, '\\$&')}\\s*\\{`);
		const i = lines.findIndex(l => re.test(l));
		if (i >= 0) {
			return i + 1;
		}
	}
	return 1;
}

/** Devicetree checks: dtc warnings, binding schemas, and the boards against them. */
export class DtChecks {
	readonly root: string;
	readonly diagnostics = vscode.languages.createDiagnosticCollection('devicetree');

	constructor(private readonly settings: Settings) {
		this.root = settings.root;
	}

	/** Checks the changed files (all dtbs when `files` is empty); returns a one-line summary. */
	async check(files: string[]): Promise<string> {
		const state = this.settings.configured();
		if (!state) {
			return 'skipped: configure a build in the Kernel tab';
		}
		const karch = archInfo(state.arch).kernelArch;
		if (!['arm64', 'riscv'].includes(karch)) {
			return `skipped: ${state.arch} kernels do not use devicetree`;
		}
		if (!onPath('dt-validate')) {
			return 'skipped: dt-schema is not installed (pip install dtschema; also yamllint)';
		}
		const full = !files.length;
		const t = targets(this.root, karch, files);
		if (!full && !t.dtbs.length && !t.schemas.length) {
			return 'no devicetree files changed';
		}
		const make = (...args: string[]) =>
			['make', ...this.settings.makeArgs(state), this.settings.jobs(), ...args]
				.map(sq)
				.join(' ');
		const dtbPath = (d: string) =>
			sq(path.join(state.buildDir, 'arch', karch, 'boot', 'dts', d));
		const steps = full
			? [make('dtbs_check')]
			: [
					// An up-to-date .dtb is not checked again: remove the targets (build output) so
					// that they are rebuilt and validated.
					...(t.dtbs.length
						? [
								`rm -f ${t.dtbs.map(dtbPath).join(' ')}`,
								make('CHECK_DTBS=y', ...t.dtbs),
							]
						: []),
					// make skips dt_binding_check when nothing changed; lint the changed schemas
					// every time, the way it would.
					...(t.schemas.length
						? [
								`yamllint -f parsable -c ${BINDINGS}.yamllint ` +
									t.schemas.map(y => sq(BINDINGS + y)).join(' '),
							]
						: []),
					...t.schemas.map(y => make('dt_binding_check', `DT_SCHEMA_FILES=${y}`)),
				];
		const log = path.join(os.tmpdir(), `kernel-workbench-dt-${process.pid}.log`);
		const what = full
			? 'all dtbs'
			: [
					t.dtbs.length && `${t.dtbs.length} dtb`,
					t.schemas.length && `${t.schemas.length} binding`,
				]
					.filter(Boolean)
					.join(', ');
		const script = steps.map(c => `${c} || rc=1`).join('; ');
		const code = await runTask(
			this.settings.folder,
			`DT check (${what})`,
			'bash',
			['-c', `set -o pipefail; { rc=0; ${script}; exit $rc; } 2>&1 | tee ${sq(log)}`],
			{ step: 'dt' },
		);
		let out = '';
		try {
			out = fs.readFileSync(log, 'utf8');
			fs.rmSync(log, { force: true });
		} catch {
			// no output at all
		}
		const findings = parse(out, this.root, state.buildDir);
		const byFile = new Map<string, vscode.Diagnostic[]>();
		for (const f of findings) {
			const diagnostic = new vscode.Diagnostic(
				new vscode.Range(f.line - 1, 0, f.line - 1, 1000),
				f.message,
				f.severity === 'error'
					? vscode.DiagnosticSeverity.Error
					: vscode.DiagnosticSeverity.Warning,
			);
			diagnostic.source = 'devicetree';
			byFile.set(f.file, [...(byFile.get(f.file) ?? []), diagnostic]);
		}
		this.diagnostics.clear();
		for (const [file, list] of byFile) {
			this.diagnostics.set(vscode.Uri.file(path.join(this.root, file)), list);
		}
		const outcome = findings.length
			? `${findings.length} findings (see Problems)`
			: code === 0
				? 'clean'
				: 'failed (see the terminal)';
		return `DT check (${what}): ${outcome}`;
	}
}

/** The devicetree checks and their commands. */
export function registerDt(context: vscode.ExtensionContext, settings: Settings): DtChecks {
	const dt = new DtChecks(settings);
	const report = (summary: string) => vscode.window.showInformationMessage(`Kernel: ${summary}`);
	context.subscriptions.push(
		dt.diagnostics,
		vscode.commands.registerCommand('kernelWorkbench.dt.checkChanged', async () => {
			const out = await git(settings.root, [
				'diff',
				'--name-only',
				'--diff-filter=d',
				'HEAD',
			]);
			const files = out.split('\n').filter(Boolean);
			report(
				files.length
					? await dt.check(files)
					: 'no uncommitted changes; use "DT Check: All dtbs" for everything',
			);
		}),
		vscode.commands.registerCommand('kernelWorkbench.dt.checkAll', async () =>
			report(await dt.check([])),
		),
	);
	return dt;
}
