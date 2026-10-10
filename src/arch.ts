import * as os from 'os';

/**
 * Per-architecture facts. Everything arch-specific the extension needs
 * lives here, so adding an architecture means adding one entry.
 */
export interface ArchInfo {
	/** value of ARCH= for kbuild */
	kernelArch: string;
	/** default CROSS_COMPILE for GCC builds when cross compiling */
	gccPrefix: string;
	/** `uname -m` value of a host that can run this natively */
	hostUname: string;
}

const ARCHES: Record<string, ArchInfo> = {
	x86_64: {
		kernelArch: 'x86_64',
		gccPrefix: 'x86_64-linux-gnu-',
		hostUname: 'x86_64',
	},
	arm64: {
		kernelArch: 'arm64',
		gccPrefix: 'aarch64-linux-gnu-',
		hostUname: 'aarch64',
	},
	riscv64: {
		kernelArch: 'riscv',
		gccPrefix: 'riscv64-linux-gnu-',
		hostUname: 'riscv64',
	},
};

function archInfo(arch: string) {
	const info = ARCHES[arch];
	if (!info) {
		throw new Error(
			`Unsupported architecture "${arch}" (supported: ${Object.keys(ARCHES).join(', ')})`,
		);
	}
	return info;
}

function isNative(arch: string) {
	return archInfo(arch).hostUname === os.machine();
}

export { ARCHES, archInfo, isNative };
