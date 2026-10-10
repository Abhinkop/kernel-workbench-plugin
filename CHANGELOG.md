# Change Log

All notable changes to the "kernel-workbench" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Kernel tab: the target (architecture, Debug/Release, base config), Configure, Build,
  Clean, Rebuild, Full clean, menuconfig/nconfig, Build modules, the host tool check, and
  the steps' options.
- Compile, preprocess or assemble the current file; build a directory.
- clangd pointed at the selected build with a `compile_commands.json`.
- Run in QEMU (or virtme-ng, or with the build directory shared over 9p) and Debug in QEMU
  with gdb, handed to the C/C++ extension, Native Debug or CodeLLDB at `start_kernel`.
- Kernel crashes noticed in the VM console and decoded with `scripts/decode_stacktrace.sh`;
  Decode Stack Trace for a pasted one.
- KUnit tests in the Testing view.
- History tab: File History (following renames, paging, filtering, line history) with
  read-only commit tabs, and blame annotations with a Blame view.
- Kernel Git tab: the Series view (checkpatch, W=1, sparse, Coccinelle and devicetree
  checks; cover letter, recipients from get_maintainer.pl, git format-patch, git send-email
  dry run and send), the Apply view (b4 from lore or local files, git am with conflicts),
  and the Bisect view (by hand or with a test script).
