# Kernel Workbench

Configure, build, run and debug the Linux kernel from VS Code.

> **Early development.** This version detects kernel source trees and lets you pick the build
> target. The build and QEMU/gdb support described in the extension's summary is not
> implemented yet.

## Features

- Activates when the workspace contains a `Kbuild` file.
- Treats a workspace folder as a kernel tree when its top-level `Makefile` sets `VERSION` and
  `PATCHLEVEL` and its git history contains the first mainline Linux commit
  (`1da177e4c3f4`).
- Sets the `kernelWorkbench.active` context key in kernel trees.
- Settings for the build target's defaults: `kernelWorkbench.arch` (empty: the host's
  architecture), `kernelWorkbench.variant` (`debug` or `release`),
  `kernelWorkbench.configure.defconfig` (the base config) and `kernelWorkbench.buildDirectory`
  (by default `build/${arch}/${variant}` in the tree).
- Pick the build target of a kernel tree from the Command Palette: **Kernel: Select
  Architecture…**, **Kernel: Select Debug or Release…** and **Kernel: Select Base Config…**.
  The base configs offered are `defconfig`, the architecture's
  `arch/<arch>/configs/*_defconfig`, `tinyconfig` and `allnoconfig`, or an existing `.config`
  file. The pick is kept per tree, and the base config per architecture.
- A **Kernel** tab in the activity bar. Its **Steps** group has a **Configure** row, showing
  what it would configure from which base config, that runs on a click. Its **Target** group
  shows the tree's architecture (and whether it is a cross build), Debug or Release, and base
  config; click a row, or its **Change…** action, to pick another. Its **Status** group shows
  whether and when the target was configured, and the step that is running. Configure is
  also a button on the editor toolbar and the Kernel view's toolbar, and in the Kernel
  Workbench menu.
- A **Kernel Workbench** menu (chip icon) on the toolbar of every editor in a kernel tree,
  with the three Select commands.
- **Kernel: Configure** configures the selected target into its build directory: the base
  config (a make target, or a `.config` file copied in), the fragments in
  `kernelWorkbench.configure.fragments` merged with `scripts/kconfig/merge_config.sh`, the
  Debug or Release options (`kernelWorkbench.configure.debugOptions` and `releaseOptions`)
  and `kernelWorkbench.configure.options` applied with `scripts/config`, then
  `make olddefconfig`; options Kconfig dropped are reported. The make arguments (`O=`,
  `ARCH=`, `CROSS_COMPILE=` from `kernelWorkbench.crossCompile` or the architecture's
  default, `LLVM=1` for `kernelWorkbench.toolchain: llvm`, `CC=ccache …` with
  `kernelWorkbench.make.ccache`, `kernelWorkbench.make.args`, and `-j` from
  `kernelWorkbench.make.jobs`) are recorded in `<build dir>/.kernel-workbench.json`. The
  step runs in a terminal that closes when it succeeds and stays open when it fails
  (`kernelWorkbench.terminal.afterTask`).
- **Kernel: Build** (F7) builds the configured target with the toolchain arguments recorded
  at Configure plus `kernelWorkbench.make.args` as set now, configuring first if the target
  was never configured. The compiler's errors and warnings go to the Problems panel.

## Requirements

- `git` on the `PATH`.
- A full clone of the kernel. Shallow clones (`git clone --depth 1`) and source unpacked from
  a tarball are not detected, because they do not contain the first mainline commit.

## Development

| Task              | Command                        |
| ----------------- | ------------------------------ |
| Build             | `npm run compile`              |
| Unit tests        | `npm run test:unit`            |
| VS Code tests     | `npm test`                     |
| Integration tests | Task **npm: test:integration** |
| UI tests          | Task **npm: test:ui**          |
| Lint              | `npm run lint`                 |
| Format            | `npm run format`               |
| Set kernel tree   | Task **Configure kernel tree** |

The integration tests, the UI tests and the **Run Extension** launch configuration all use the
kernel tree set in `kernelWorkbench.dev.kernelTree` in `.vscode/settings.json`. Set it with the
**Configure kernel tree** task. It must be a full clone (not `--depth 1`). Both test suites
run on a throwaway `--shared` clone of that tree, so steps such as Configure can write into
it without touching yours; they need `git` and the kernel's build tools (`make`, `gcc`,
`flex`, `bison`, ...). The UI tests click through a real VS Code window with
[vscode-extension-tester](https://github.com/redhat-developer/vscode-extension-tester); the
first run downloads VS Code and ChromeDriver into `.vscode-test/extest`. CI clones mainline
Linux for both.
