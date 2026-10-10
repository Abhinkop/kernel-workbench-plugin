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
- A **Kernel** tab in the activity bar. Its **Target** group shows the tree's architecture
  (and whether it is a cross build), Debug or Release, and base config; click a row, or its
  **Change…** action, to pick another.
- A **Kernel Workbench** menu (chip icon) on the toolbar of every editor in a kernel tree,
  with the three Select commands.

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
| Lint              | `npm run lint`                 |
| Format            | `npm run format`               |
| Set kernel tree   | Task **Configure kernel tree** |

The integration tests and the **Run Extension** launch configuration both use the kernel tree
set in `kernelWorkbench.dev.kernelTree` in `.vscode/settings.json`. Set it with the
**Configure kernel tree** task. It must be a full clone (not
`--depth 1`). The integration tests also need `git` and `make`. CI clones mainline Linux for them.
