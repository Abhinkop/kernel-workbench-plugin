// Devicetree checks: the dtbs and schemas a change touches, the findings in dtc, yamllint
// and dt-schema output, why a check is skipped, and the check run with stand-in tools.
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { extensionContext, state, vscode, workspaceFolder } from '../helpers/vscode';
import { kernelTree, tempDir } from '../helpers/repo';
import { DtChecks, nodeLine, parse, registerDt, targets } from '../../dt';
import { Settings } from '../../settings';
import type { Configured } from '../../settings';

describe('devicetree', () => {
	const configured = (arch: string, buildDir = tempDir()): Configured => ({
		arch,
		variant: 'debug',
		config: 'defconfig',
		buildDir,
		makeArgs: [`O=${buildDir}`, `ARCH=${arch === 'arm64' ? 'arm64' : arch}`],
		configuredAt: new Date().toISOString(),
	});

	it('maps changed files to dtbs and schemas', () => {
		const root = tempDir();
		const d = path.join(root, 'arch/arm64/boot/dts/arm');
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, 'juno.dts'), '#include "juno-base.dtsi"\n');
		fs.writeFileSync(path.join(d, 'juno-r1.dts'), '#include "juno-base.dtsi"\n');
		fs.writeFileSync(path.join(d, 'other.dts'), '/ {};\n');
		const t = targets(root, 'arm64', [
			'arch/arm64/boot/dts/arm/juno-base.dtsi',
			'arch/arm64/boot/dts/arm/other.dts',
			'Documentation/devicetree/bindings/serial/8250.yaml',
			'drivers/x.c',
		]);
		assert.deepEqual(t.dtbs, ['arm/juno-r1.dtb', 'arm/juno.dtb', 'arm/other.dtb']);
		assert.deepEqual(t.schemas, ['serial/8250.yaml']);
	});

	it('parses dtc, yamllint and dt-schema output', () => {
		const root = tempDir();
		const dts = path.join(root, 'arch/arm64/boot/dts/arm/juno.dts');
		fs.mkdirSync(path.dirname(dts), { recursive: true });
		fs.writeFileSync(dts, '/ {\n\tsoc {\n\t\tbogus@1000 {\n\t\t};\n\t};\n};\n');
		const out = [
			'arch/arm64/boot/dts/arm/juno.dts:3.3-4.5: Warning (unit_address_vs_reg): ' +
				'/soc/bogus@1000: node has a unit name, but no reg',
			`Error: ${dts}:20.2-44 Properties must precede subnodes`,
			'Documentation/devicetree/bindings/serial/8250.yaml:7:9: [warning] ' +
				'too many spaces after colon (colons)',
			`${path.join('/build', 'arch/arm64/boot/dts/arm/juno')}.dtb: /soc/bogus@1000: ` +
				"failed to match any schema with compatible: ['acme,x']",
			'arch/arm64/boot/dts/arm/juno.dtb: / (arm,juno): bogus@1000: ' +
				"'anyOf' conditional failed",
		].join('\n');
		const findings = parse(out, root, '/build');
		assert.deepEqual(
			findings.map(f => [f.file, f.line, f.severity]),
			[
				['arch/arm64/boot/dts/arm/juno.dts', 3, 'warning'],
				['arch/arm64/boot/dts/arm/juno.dts', 20, 'error'],
				['Documentation/devicetree/bindings/serial/8250.yaml', 7, 'warning'],
				['arch/arm64/boot/dts/arm/juno.dts', 3, 'warning'],
				['arch/arm64/boot/dts/arm/juno.dts', 3, 'warning'],
			],
		);
		assert.equal(nodeLine(dts, 'no node here'), 1);
	});

	it('explains why it skips', async () => {
		const settings = new Settings(extensionContext(), workspaceFolder(tempDir()));
		const checks = new DtChecks(settings);
		settings.configured = () => undefined;
		assert.match(await checks.check(['a.dts']), /configure a build/);
		settings.configured = () => configured('x86_64');
		assert.match(await checks.check(['a.dts']), /do not use devicetree/);
	});

	it('checks the changed boards and bindings, with the findings in Problems', async () => {
		const root = kernelTree();
		const settings = new Settings(extensionContext(), workspaceFolder(root));
		const bin = tempDir();
		const PATH = process.env.PATH;
		try {
			const dts = 'arch/arm64/boot/dts/acme/board.dts';
			fs.mkdirSync(path.join(root, path.dirname(dts)), { recursive: true });
			fs.writeFileSync(
				path.join(root, dts),
				'/ {\n\tsoc {\n\t\tbogus@1000 {\n\t\t};\n\t};\n};\n',
			);
			// Stand-ins: dt-validate marks dt-schema as installed; make prints a dtc warning.
			fs.writeFileSync(path.join(bin, 'dt-validate'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
			fs.writeFileSync(
				path.join(bin, 'make'),
				'#!/bin/sh\necho "MAKE $*"\n' +
					`echo "${dts}:3.3-4.5: Warning (unit_address_vs_reg): ` +
					'/soc/bogus@1000: no reg"\n',
				{ mode: 0o755 },
			);
			process.env.PATH = `${bin}:${PATH}`;
			settings.configured = () => configured('arm64');
			const dt = registerDt(extensionContext(), settings);
			const summary = await dt.check([dts, 'drivers/x.c']);
			assert.equal(summary, 'DT check (1 dtb): 1 findings (see Problems)');
			const task = state.tasks.pop();
			assert.ok(task);
			assert.match(task.output, /^MAKE .*CHECK_DTBS=y acme\/board\.dtb$/m);
			const key = `devicetree|${vscode.Uri.file(path.join(root, dts)).toString()}`;
			const placed = state.diagnostics.get(key) as { range: { start: { line: number } } }[];
			assert.equal(placed?.[0].range.start.line, 2);
			assert.equal(await dt.check(['drivers/x.c']), 'no devicetree files changed');
			await vscode.commands.executeCommand('kernelWorkbench.dt.checkAll');
			assert.match(String(state.log.pop()?.message), /^Kernel: DT check \(all dtbs\)/);
		} finally {
			process.env.PATH = PATH;
		}
	});
});
