import * as fs from 'fs';
import * as path from 'path';
import type { Settings } from './settings';

/** One thing the workflow needs from the host. */
export interface Requirement {
	step: 'build';
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

/** Everything Configure and Build need for the current selection. */
export function requirements(settings: Settings): Requirement[] {
	const recorded = settings.configured();
	return buildRequirements(recorded ? recorded.makeArgs : settings.makeArgsForConfigure());
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
