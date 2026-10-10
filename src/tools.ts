import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { archInfo } from './arch';
import type { Settings } from './settings';

/** One thing the workflow needs from the host. */
export interface Requirement {
	step: 'build' | 'run' | 'debug';
	/** binary name, header path, or a description */
	what: string;
	/** Debian/Ubuntu package that provides it */
	pkg?: string;
	/** what to do when there is no package */
	hint?: string;
	present: () => boolean;
}

/**
 * Build tools for a set of make arguments (recorded at Configure, or the ones
 * the next Configure would use).
 */
export function buildRequirements(makeArgs: string[]): Requirement[] {
	const llvm = makeArgs.includes('LLVM=1');
	const crossArg = makeArgs.find(a => a.startsWith('CROSS_COMPILE=')) ?? '';
	const cross = crossArg.slice('CROSS_COMPILE='.length);
	const bins: [string, string][] = llvm
		? [
				['clang', 'clang'],
				['ld.lld', 'lld'],
				['llvm-ar', 'llvm'],
				['llvm-nm', 'llvm'],
				['llvm-objcopy', 'llvm'],
			]
		: [
				[`${cross}gcc`, cross ? `gcc-${cross.replace(/-$/, '')}` : 'gcc'],
				[`${cross}ld`, cross ? `binutils-${cross.replace(/-$/, '')}` : 'binutils'],
			];
	if (!llvm && cross) {
		// Host programs (scripts/, tools/) are built with the host compiler.
		bins.push(['gcc', 'gcc']);
	}
	bins.push(
		['make', 'make'],
		['flex', 'flex'],
		['bison', 'bison'],
		['bc', 'bc'],
		['perl', 'perl'],
		['python3', 'python3'],
	);
	if (makeArgs.some(a => /^CC=ccache /.test(a))) {
		bins.push(['ccache', 'ccache']);
	}
	return [
		...bins.map(([bin, pkg]): Requirement => ({
			step: 'build',
			what: bin,
			pkg,
			present: () => onPath(bin),
		})),
		header('libelf/gelf.h', 'gelf.h', 'libelf-dev'),
		header('OpenSSL headers', 'openssl/ssl.h', 'libssl-dev'),
	];
}

/** Everything Configure, Build, Run and Debug need for the current selection. */
export function requirements(settings: Settings): Requirement[] {
	const arch = settings.arch;
	const info = archInfo(arch);
	const recorded = settings.configured();
	const reqs = buildRequirements(recorded ? recorded.makeArgs : settings.makeArgsForConfigure());

	if (settings.get('run.mode', 'qemu') === 'virtme') {
		reqs.push({ step: 'run', what: 'vng', pkg: 'virtme-ng', present: () => onPath('vng') });
	} else {
		reqs.push({
			step: 'run',
			what: info.qemu,
			pkg: qemuPackage(arch),
			present: () => onPath(info.qemu),
		});
		const initramfs = settings.get<Record<string, string>>('run.initramfs', {})[arch];
		if (initramfs) {
			reqs.push({
				step: 'run',
				what: `initramfs ${initramfs}`,
				hint: 'fix kernelWorkbench.run.initramfs',
				present: () => fs.existsSync(path.resolve(settings.root, initramfs)),
			});
		}
	}

	const gdb = settings.gdbPath();
	const gdbPackage =
		gdb === 'gdb-multiarch' ? 'gdb-multiarch' : gdb === 'gdb' ? 'gdb' : undefined;
	reqs.push({ step: 'debug', what: gdb, pkg: gdbPackage, present: () => onPath(gdb) });
	return reqs;
}

/** Whether apt knows a package, by name; tests may seed it. */
export const aptKnows = new Map<string, boolean>();

function aptHas(pkg: string): boolean {
	if (!aptKnows.has(pkg)) {
		let has = false;
		try {
			const policy = execFileSync('apt-cache', ['policy', pkg], {
				encoding: 'utf8',
				timeout: 5000,
			});
			has = /^Candidate: (?!\(none\))/m.test(policy);
		} catch {
			// no apt, or no such package
		}
		aptKnows.set(pkg, has);
	}
	return aptKnows.get(pkg) ?? false;
}

/**
 * The Debian/Ubuntu package with an arch's QEMU. qemu-system-riscv64 was in
 * qemu-system-misc until QEMU 10 packaging split it out (Debian trixie+, Ubuntu 25.10+).
 */
export function qemuPackage(arch: string): string {
	if (arch === 'riscv64') {
		return aptHas('qemu-system-riscv') ? 'qemu-system-riscv' : 'qemu-system-misc';
	}
	return { x86_64: 'qemu-system-x86', arm64: 'qemu-system-arm' }[arch] ?? 'qemu-system';
}

/** The requirements that the host does not meet. */
export function missing(settings: Settings): Requirement[] {
	return requirements(settings).filter(r => !r.present());
}

/** One apt-get command installing every package named; empty without apt-get or packages. */
export function installCommand(reqs: Requirement[]): string {
	const pkgs = [...new Set(reqs.map(r => r.pkg).filter((p): p is string => !!p))];
	return pkgs.length && onPath('apt-get') ? `sudo apt-get install ${pkgs.join(' ')}` : '';
}

/** "build: flex, bison · run: qemu-system-x86_64" */
export function describe(reqs: Requirement[]): string {
	const by: Record<string, string[]> = {};
	for (const r of reqs) {
		(by[r.step] ??= []).push(r.hint ? `${r.what} (${r.hint})` : r.what);
	}
	return Object.entries(by)
		.map(([step, list]) => `${step}: ${list.join(', ')}`)
		.join(' · ');
}

function header(label: string, relative: string, pkg: string): Requirement {
	return {
		step: 'build',
		what: label,
		pkg,
		present: () =>
			['/usr/include', '/usr/local/include'].some(dir =>
				fs.existsSync(path.join(dir, relative)),
			),
	};
}

/** Whether a program is on PATH (or, given with a directory, exists). */
export function onPath(bin: string): boolean {
	if (bin.includes('/')) {
		return fs.existsSync(bin);
	}
	return (process.env.PATH ?? '').split(path.delimiter).some(dir => {
		try {
			fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}
