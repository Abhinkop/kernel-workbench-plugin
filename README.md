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
- A **Kernel** tab in the activity bar. Its **Steps** group has **Configure** and **Build**
  rows, showing what they would configure or build, that run on a click; its collapsed
  **More** group has menuconfig, nconfig, Clean, Rebuild and Full clean, which are also in
  the view's **…** menu and the Kernel Workbench menu. Its collapsed **Options** group lists
  the settings the steps use (toolchain, CROSS_COMPILE, ccache, make arguments, config
  fragments and options, what happens to a step's terminal, how to boot, the initramfs, the
  shared build directory, the kernel command line, QEMU arguments, memory, CPUs) with their
  values; a click, or **Change…**, edits one with a picker or an input box, written where its
  value comes from (the workspace if set there, else your user settings). Its **Target** group
  shows the tree's architecture (and whether it is a cross build), Debug or Release, and base
  config; click a row, or its **Change…** action, to pick another. Its **Status** group shows
  whether and when the target was configured and built (and which image), whether a VM is
  running, and the step that is running. Configure, Build, Run and Debug are also buttons on
  the editor toolbar and the Kernel view's toolbar, and in the Kernel Workbench menu.
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
- **Kernel: Clean**, **Rebuild (Clean + Build)** and **Full Clean (mrproper)**, which also
  forgets the configuration; **Run menuconfig** and **Run nconfig**, which open on the
  configured build in a terminal in the editor area (they need at least 19 lines by 80
  columns) and close when they exit cleanly.
- A check of the host's tools for the selected toolchain (compilers, binutils, make, flex,
  bison, bc, perl, python3, ccache when used, the libelf and OpenSSL headers), when the
  extension loads and after every change. The **Status › Tools** row of the Kernel tab lists
  what is missing, with an inline **Install Missing Tools** action that runs the apt-get
  command in a terminal; a warning offers the same once per set of missing tools, until
  **Don't Show Again**. **Kernel: Check Required Tools** (also under More) checks on demand.
  Configure and Build refuse to start without the tools, naming them.
- clangd set up without any files of yours: after each Build, the build's
  `compile_commands.json` is written to the root of the tree, where clangd looks (gcc-only
  flags stripped and `--target` made explicit for GCC builds; LLVM builds copied as they
  are), and clangd is restarted if its extension is installed. Switching the architecture
  or Debug/Release points clangd at that build if it exists; **Kernel: Point clangd at the
  Selected Build** does so on demand. `kernelWorkbench.clangd.updateCompileCommands` turns
  this off.
- **Kernel: Compile Current File** (Ctrl+F7 in a C file), **Preprocess Current File (.i)**
  and **Show Assembly for Current File (.s)** compile one file of the configured build; the
  `.i` and `.s` open beside the editor. **Build This Directory**, in the editor's and the
  Explorer's right-click menus under **Kernel Workbench**, builds a directory's objects and
  links the modules it compiled. **Build Modules** (under More) runs `make modules` on a built
  kernel (modpost needs `vmlinux.o`).
- **Kernel: Run in QEMU** (Ctrl+F5, the Run row, the toolbar) builds if needed
  (`kernelWorkbench.buildBeforeRun`) and boots the kernel image in QEMU in a terminal, with
  the initramfs from `kernelWorkbench.run.initramfs` for the architecture (an initramfs set
  but missing is an error), KVM when the architecture is native and `/dev/kvm` is usable
  (`kernelWorkbench.run.kvm`), `kernelWorkbench.run.memory` and `run.smp`, the extra
  `run.cmdline` and `run.qemuArgs`; Configure applies `kernelWorkbench.configure.qemuOptions`
  so an initramfs can boot. The console also goes to `<build dir>/kernel-workbench/console.log`.
  A QEMU that fails keeps its terminal to read; a clean exit (Ctrl-A X) closes it. While the
  VM runs, the Run row and button become **Stop VM**, and Status › VM says so.
- **Kernel: Debug in QEMU** (F5, the Debug row, the toolbar) boots the kernel halted with a
  gdbstub (`kernelWorkbench.debug.port`, `nokaslr`), runs it to `kernelWorkbench.debug.breakAt`
  (`start_kernel`) on a hardware breakpoint with a throwaway gdb, then attaches the debugger
  front end there (`kernelWorkbench.debug.debugger`: the C/C++ extension, Native Debug or
  CodeLLDB, whichever is installed; offered for installation otherwise) with an in-memory
  configuration: `vmlinux`, the kernel's gdb scripts on the safe path, pretty printing and
  `kernelWorkbench.debug.gdbCommands`. `debug.gdb` picks the gdb (`gdb-multiarch` for a cross
  build by default), `debug.stopOnEntry` stays at the symbol, and ending the session stops
  QEMU (`debug.stopVmWhenDebuggingEnds`). A Release build has no debug info: Debug offers to
  switch.
- Other ways to boot: `kernelWorkbench.run.mode: virtme` runs the kernel with
  [virtme-ng](https://github.com/arighi/virtme-ng) (`vng`) on the host's root file system
  (Configure applies `kernelWorkbench.configure.virtmeOptions`; `run.virtmeArgs` adds vng
  arguments; the tool check wants `vng`). `kernelWorkbench.run.shareBuildDir` shares the
  build directory with the QEMU guest over 9p, read-only, so a freshly built module can be
  loaded with `insmod` without rebuilding the initramfs: Configure enables the 9p and virtio
  options, and the VM terminal shows the `mount` command. The tool check also covers QEMU for
  the architecture, the initramfs set for it, and gdb.
- **Kernel: Decode Stack Trace**: while the VM runs in QEMU, its console log is watched, and
  when an Oops, BUG, WARNING, panic or general protection fault appears a notification names
  it; **Show Decoded Trace** runs `scripts/decode_stacktrace.sh` against the build's `vmlinux`
  (with its `LLVM=` and `CROSS_COMPILE=`) and opens a tab where every `file:line` is a link,
  with the reliable frames (not the `?` ones) in Problems. The command, from the palette or the
  editor's Kernel Workbench menu with a selection, does the same for a trace you select or
  copy.
- **KUnit** tests appear in VS Code's Testing view. **Run in QEMU** runs
  `tools/testing/kunit/kunit.py run` for the selected architecture and toolchain in its own
  build directory (`kernelWorkbench.kunit.buildDirectory`, `build/kunit/<arch>`) with
  `kernelWorkbench.kunit.kunitconfig` (`lib/kunit`, say; empty: kunit.py's default set). The
  suites and cases appear after the first run, a run of one suite keeps the others' results,
  and a failure links to its `EXPECTATION FAILED at file:line`. **Run KUnit Tests for This
  Directory** (the Explorer's Kernel Workbench menu, the palette) uses the nearest
  `.kunitconfig`.
- **File History** (the History icon in the Activity Bar) lists every commit that touched the
  file in the editor, following renames, 200 at a time with _Load 200 more…_. **Filter
  History by Message or Author…** searches across the file's old names too, and **Show
  History of Selected Lines** (the editor's Kernel Workbench menu) runs `git log -L`. Clicking
  a commit opens it as a read-only `kernel-git:` diff tab whose toolbar switches between the
  whole commit and this file only (a commit too large for a tab opens as this file's part of
  it, or as its message and file list); a commit's right-click menu copies its hash or
  `Fixes:` line, opens the file at that commit, compares it with the previous version, or
  opens its `Link:` on lore.kernel.org.
- **Kernel: Toggle Blame Annotations** (the editor's menus, the History container's Blame
  view) shows the hash, date and author before each run of lines from the same commit;
  unsaved edits stay aligned, and `kernelWorkbench.blame.ignoreWhitespace` (`-w`, on) and
  `blame.detectMoves` (`-M -C`) shape the blame. Clicking a hash opens the commit; its hover
  also blames before that commit and copies the `Fixes:` line. The **Blame** view follows the
  cursor: the commit that last changed the line and, with `git log -L`, every earlier commit
  that changed it, the bottom one having introduced it; **Blame Before This Commit** reopens
  the file as of the parent, at the same line.
- **Series** (the Kernel Git icon in the Activity Bar): the commits of the current branch on
  top of its base, which is the one picked with **Pick Series Base…**, else the branch's
  upstream, else `kernelWorkbench.patches.base` (`origin/master`; a welcome view asks when
  none exists). **Check Series** runs checkpatch on every commit (`--strict` and an ignore
  list from Check options) and then W=1, with sparse (`C=2`) and Coccinelle when enabled, on
  every `.c` file the series touches in the Kernel tab's build; a commit's icon shows its
  result, its hover the commit-message findings, and the inline action its raw report. The
  findings go to Problems on the right line of the working tree, mapped through the later
  changes. **Check Working Changes** checks the uncommitted diff, **Format Changed Lines**
  runs `git clang-format` against the base, and the series version (for `-vN`) is kept per
  branch.
- **Generate Patches** (the Series view): `git format-patch -vN --cover-letter --base=…
--to/--cc … -o patches/<branch>/v<N>` (`kernelWorkbench.patches.outputDirectory`), with
  the **Subject prefix** (`PATCH`, `PATCH net-next`, `RFC PATCH`, …) and the **Cover letter**,
  which is stored as the git branch description so it survives regenerating; **Fill
  Recipients from get_maintainer.pl** puts maintainers and reviewers in To and lists in Cc,
  and **Edit Recipients** opens them in a tab. If checkpatch reports errors, they are listed
  and the patches are only generated on _Generate Anyway_; the generated files are listed
  under the Patches group and open on a click.
- **Send Patches: Dry Run** (`git send-email --dry-run`) lists every mail and its recipients
  in a tab, with the SMTP setup from `git config` (`sendemail.smtpServer` and so on, which
  you configure yourself); **Send Patches…** is offered only after a successful dry run of
  exactly these files, asks once, and sends in a terminal (SMTP may ask for a password).
- **Apply** (the Kernel Git tab): **Fetch Series from lore…** takes a lore link or
  Message-ID and runs `b4 am`, which takes the latest version, puts the patches in order and
  collects the Reviewed-by/Acked-by/Tested-by from the replies (`kernelWorkbench.apply.addLink`
  and `apply.addSignoff` add `Link:` and your `Signed-off-by:`); **Apply mbox or Patch
  Files…** loads local files. The view shows the series, its base and the trailers before
  anything is applied; **Apply to Current Branch** or **Apply on New Branch…** (at the
  series' base-commit) runs `git am -3`. If `git am` stops, the view shows the patch and the
  conflicted files, and **Continue** (refused while conflict markers remain), **Skip** and
  **Abort** are in the toolbar.

## Requirements

- `git` on the `PATH`.
- A full clone of the kernel. Shallow clones (`git clone --depth 1`) and source unpacked from
  a tarball are not detected, because they do not contain the first mainline commit.

## Development

| Task              | Command                                     |
| ----------------- | ------------------------------------------- |
| Build             | `npm run compile`                           |
| Unit tests        | `npm run test:unit`                         |
| VS Code tests     | `npm test`                                  |
| Integration tests | Task **npm: test:integration**              |
| End to end        | Task **npm: test:integration (end to end)** |
| UI tests          | Task **npm: test:ui**                       |
| Lint              | `npm run lint`                              |
| Format            | `npm run format`                            |
| Set kernel tree   | Task **Configure kernel tree**              |

The integration tests, the UI tests and the **Run Extension** launch configuration all use the
kernel tree set in `kernelWorkbench.dev.kernelTree` in `.vscode/settings.json`. Set it with the
**Configure kernel tree** task. It must be a full clone (not `--depth 1`). Both test suites
run on a throwaway `--shared` clone of that tree, so steps such as Configure can write into
it without touching yours; they need `git` and the kernel's build tools (`make`, `gcc`,
`flex`, `bison`, ...). The end-to-end tests (`KERNEL_E2E=1`) also build a kernel, which takes
minutes. The UI tests click through a real VS Code window with
[vscode-extension-tester](https://github.com/redhat-developer/vscode-extension-tester); the
first run downloads VS Code and ChromeDriver into `.vscode-test/extest`. CI clones mainline
Linux for both.
