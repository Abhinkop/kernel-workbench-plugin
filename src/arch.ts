import * as os from 'os';

/**
 * Per-architecture facts. Everything arch-specific the extension needs
 * lives here, so adding an architecture means adding one entry.
 */
export interface ArchInfo {
	/** value of ARCH= for kbuild */
	kernelArch: string;
	/** kernel image path, relative to the build dir */
	image: string;
	/** default CROSS_COMPILE for GCC builds when cross compiling */
	gccPrefix: string;
	/** --target= triple clangd needs for GCC compile databases */
	clangTarget: string;
	/** qemu-system binary */
	qemu: string;
	/** machine/cpu args (TCG) */
	machine: string[];
	/** machine/cpu args when KVM is usable */
	machineKvm: string[];
	/** console= for the kernel command line */
	console: string;
	/** --arch value for virtme-ng */
	vngArch: string;
	/** `uname -m` value of a host that can run this natively */
	hostUname: string;
}

const ARCHES: Record<string, ArchInfo> = {
	x86_64: {
		kernelArch: 'x86_64',
		image: 'arch/x86/boot/bzImage',
		gccPrefix: 'x86_64-linux-gnu-',
		clangTarget: 'x86_64-linux-gnu',
		qemu: 'qemu-system-x86_64',
		machine: ['-M', 'q35', '-cpu', 'max'],
		machineKvm: ['-M', 'q35', '-cpu', 'host', '-enable-kvm'],
		console: 'ttyS0',
		vngArch: 'amd64',
		hostUname: 'x86_64',
	},
	arm64: {
		kernelArch: 'arm64',
		image: 'arch/arm64/boot/Image',
		gccPrefix: 'aarch64-linux-gnu-',
		clangTarget: 'aarch64-linux-gnu',
		qemu: 'qemu-system-aarch64',
		machine: ['-M', 'virt', '-cpu', 'max'],
		machineKvm: ['-M', 'virt', '-cpu', 'host', '-enable-kvm'],
		console: 'ttyAMA0',
		vngArch: 'arm64',
		hostUname: 'aarch64',
	},
	riscv64: {
		kernelArch: 'riscv',
		image: 'arch/riscv/boot/Image',
		gccPrefix: 'riscv64-linux-gnu-',
		clangTarget: 'riscv64-linux-gnu',
		qemu: 'qemu-system-riscv64',
		machine: ['-M', 'virt', '-cpu', 'rv64', '-bios', 'default'],
		machineKvm: ['-M', 'virt', '-cpu', 'host', '-enable-kvm', '-bios', 'default'],
		console: 'ttyS0',
		vngArch: 'riscv64',
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
