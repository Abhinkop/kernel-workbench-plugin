import * as vscode from 'vscode';
import { registerApply } from './apply';
import type { Apply, ApplyTree } from './apply';
import { registerBisect } from './bisect';
import type { Bisect, BisectTree } from './bisect';
import { registerBlame } from './blame';
import type { BlameAnnotations, BlameView } from './blame';
import { followSelection } from './clangd';
import { registerDt } from './dt';
import type { DtChecks } from './dt';
import { GitDocuments, SCHEME as GIT_SCHEME } from './commits';
import { registerHistory } from './history';
import type { FileHistory } from './history';
import { Kbuild } from './kbuild';
import { isKernelTree } from './kernelTree';
import { KernelView, registerKernelView } from './kernelView';
import { registerKunit } from './kunit';
import type { Kunit } from './kunit';
import { registerOops } from './oops';
import type { OopsWatcher } from './oops';
import type { Patches } from './patches';
import { Runner } from './runner';
import type { Sender } from './send';
import { registerSeries } from './series';
import type { Series, SeriesTree } from './series';
import { Settings } from './settings';
import { registerToolCheck, runInstall } from './toolCheck';
import { installCommand, missing } from './tools';
import { pickArch, pickVariant, pickConfig, syncContextKeys } from './ui';

/** The extension's parts, returned by activate() for the tests. */
export interface KernelWorkbench {
	settings: Settings;
	kbuild: Kbuild;
	runner: Runner;
	/** Watches the VM's console for crashes, and decodes stack traces. */
	oops: OopsWatcher;
	/** KUnit in the Testing view. */
	kunit: Kunit;
	/** The File History view. */
	history: FileHistory;
	/** The blame annotations and the Blame view. */
	blame: { annotations: BlameAnnotations; blameView: BlameView };
	/** The Series view: the branch's commits over its base, their checks, patches and sending. */
	series: { series: Series; patches: Patches; sender: Sender; view: SeriesTree };
	/** The Apply view: a series fetched with b4 or loaded from files, and git am. */
	apply: { apply: Apply; view: ApplyTree };
	/** The Bisect view: git bisect, by hand or with a test script. */
	bisect: { bisect: Bisect; view: BisectTree };
	/** The devicetree checks. */
	dt: DtChecks;
	kernelView: KernelView;
	/** The tool check; `always` shows the result even when unchanged. */
	checkTools: (always: boolean) => Promise<void>;
}

/** Called by VS Code when a workspace containing a Kbuild file is opened. */
export function activate(context: vscode.ExtensionContext): KernelWorkbench | undefined {
	const folder = (vscode.workspace.workspaceFolders ?? []).find(workspaceFolder =>
		isKernelTree(workspaceFolder.uri.fsPath),
	);
	if (!folder) {
		return undefined;
	}
	vscode.commands.executeCommand('setContext', 'kernelWorkbench.active', true);

	const settings = new Settings(context, folder);
	const kbuild = new Kbuild(settings);
	const runner = new Runner(context, settings, kbuild);
	const oops = registerOops(context, settings);
	runner.onBoot = (log, state) => oops.watch(log, state);
	const kunit = registerKunit(context, settings);
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			GIT_SCHEME,
			new GitDocuments(settings.root),
		),
	);
	const history = registerHistory(context, settings.root);
	const blame = registerBlame(context, settings.root);
	const series = registerSeries(context, settings);
	const apply = registerApply(context, settings);
	const bisect = registerBisect(context, settings);
	const dt = registerDt(context, settings);
	series.series.dt = dt;
	syncContextKeys(context, runner);
	const kernelView = registerKernelView(context, settings, kbuild, runner);
	const checkTools = registerToolCheck(context, settings, kernelView);
	registerCommands(context, settings, kbuild, runner, checkTools);
	return {
		settings,
		kbuild,
		runner,
		oops,
		kunit,
		history,
		blame,
		series,
		apply,
		bisect,
		dt,
		kernelView,
		checkTools,
	};
}

/** Called by VS Code when the extension is shut down. */
export function deactivate(): void {}

/** Registers the Kernel Workbench commands, disposed of when the extension is deactivated. */
function registerCommands(
	context: vscode.ExtensionContext,
	settings: Settings,
	kbuild: Kbuild,
	runner: Runner,
	checkTools: (always: boolean) => Promise<void>,
): void {
	/** The active editor's file, compiled to `kind`. */
	const compileCurrent = (kind: '.o' | '.i' | '.s') => () => {
		const editor = vscode.window.activeTextEditor;
		return editor ? kbuild.compileFile(editor.document.uri, kind) : undefined;
	};
	// Switching arch or variant points clangd at that build, if it exists.
	const reselect = (pick: () => Promise<void>) => async () => {
		await pick();
		await followSelection(settings.root, settings.configured());
	};
	const commands: [string, (...args: any[]) => any][] = [
		['kernelWorkbench.selectArch', reselect(() => pickArch(settings))],
		['kernelWorkbench.selectVariant', reselect(() => pickVariant(settings))],
		['kernelWorkbench.selectConfig', () => pickConfig(settings)],
		[
			'kernelWorkbench.followSelection',
			() => followSelection(settings.root, settings.configured()),
		],
		['kernelWorkbench.configure', () => kbuild.configure()],
		['kernelWorkbench.build', () => kbuild.build()],
		[
			'kernelWorkbench.rebuild',
			async () => ((await kbuild.clean()) === 0 ? kbuild.build() : 1),
		],
		['kernelWorkbench.clean', () => kbuild.clean()],
		['kernelWorkbench.mrproper', () => kbuild.mrproper()],
		['kernelWorkbench.menuconfig', () => kbuild.interactiveConfig('menuconfig')],
		['kernelWorkbench.nconfig', () => kbuild.interactiveConfig('nconfig')],
		['kernelWorkbench.compileFile', compileCurrent('.o')],
		['kernelWorkbench.preprocessFile', compileCurrent('.i')],
		['kernelWorkbench.assembleFile', compileCurrent('.s')],
		['kernelWorkbench.buildModules', () => kbuild.buildModules()],
		['kernelWorkbench.buildDirectory', (uri?: vscode.Uri) => kbuild.buildDirectory(uri)],
		['kernelWorkbench.run', () => runner.run()],
		['kernelWorkbench.debug', () => runner.debug()],
		['kernelWorkbench.stop', () => runner.stop()],
		['kernelWorkbench.checkTools', () => checkTools(true)],
		[
			'kernelWorkbench.installTools',
			() => {
				const command = installCommand(missing(settings));
				if (command) {
					runInstall(settings, command);
				}
			},
		],
	];
	for (const [id, fn] of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	}
}
