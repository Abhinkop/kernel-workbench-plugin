# Kernel Dev

Configure, build, run and debug the Linux kernel from VS Code.

> **Early development.** This version only detects kernel source trees. The Kernel panel,
> build and QEMU/gdb support described in the extension's summary are not implemented yet.

## Features

- Activates when the workspace contains a `Kbuild` file.
- Treats a workspace folder as a kernel tree when its top-level `Makefile` sets `VERSION` and
  `PATCHLEVEL` and its git history contains the first mainline Linux commit
  (`1da177e4c3f4`).
- Sets the `kernelDev.active` context key in kernel trees.

## Requirements

- `git` on the `PATH`.
- A full clone of the kernel. Shallow clones (`git clone --depth 1`) and source unpacked from
  a tarball are not detected, because they do not contain the first mainline commit.

## Development

| Task          | Command             |
| ------------- | ------------------- |
| Build         | `npm run compile`   |
| Unit tests    | `npm run test:unit` |
| VS Code tests | `npm test`          |
| Lint          | `npm run lint`      |
| Format        | `npm run format`    |
