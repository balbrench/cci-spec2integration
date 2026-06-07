// Spec2Integration VS Code extension entry point.
//
// In-IDE project launcher + navigator + guided command composer for the
// spec-driven integration pipeline. With no workspace open it offers to scaffold
// a new greenfield or BizTalk-migration project (bundled agents/skills/commands).
// With a workspace open it reads status.json / state.json, renders a live stage
// tree + progress view, raises stage/Sev-1 notifications, and hands assembled
// slash commands to the live Claude Code chat. It never runs commands headlessly.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { PipelineTreeProvider, IntegrationNode, StageNode, DomainNode, BiztalkGroupNode } from './tree';
import { COMMANDS, findCommand, CommandSpec } from './commandCatalog';
import { compose, ComposeContext } from './composer';
import { sendToChat } from './chatBridge';
import { openVisualizer, refreshVisualizer } from './visualizer';
import { openProgress, refreshProgress } from './progress';
import { openPath, openPreview } from './artifacts';
import { registerIrSchema } from './schemaContributor';
import { readState, readStatus, discoverBiztalkSolutions } from './discovery';
import { newProject, offerFirstStepIfPending } from './scaffold';
import { Mode, updateAssetsFromGitHub, readManifest } from './assets';
import { checkNotifications } from './notifications';
import { initSessionStore, setSessionId, getSessionId } from './session';

function resolveRepoRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Pick a command from the catalog via QuickPick, grouped by intent. */
async function pickCommand(): Promise<CommandSpec | undefined> {
  const items = COMMANDS.map((c) => ({
    label: c.label,
    description: c.group,
    detail: c.detail,
    spec: c,
  }));
  const sel = await vscode.window.showQuickPick(items, {
    title: 'Compose a Spec2Integration command',
    placeHolder: 'Pick a slash command — the wizard will collect its options',
    matchOnDetail: true,
  });
  return sel?.spec;
}

async function defaultFolder(repoRoot: string, explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  const state = await readState(repoRoot);
  return state.activeIntegration ?? null;
}

async function composeAndSend(repoRoot: string, cmd: CommandSpec, folder?: string | null): Promise<void> {
  const ctx: ComposeContext = { repoRoot, defaultFolder: await defaultFolder(repoRoot, folder) };
  const prompt = await compose(cmd, ctx);
  if (prompt === undefined) return; // cancelled
  await sendToChat(prompt);
}

const reg = (context: vscode.ExtensionContext, id: string, fn: (...args: any[]) => any) =>
  context.subscriptions.push(vscode.commands.registerCommand(id, fn));

/** Commands available with or without a workspace open (the launcher surface). */
function registerLauncherCommands(context: vscode.ExtensionContext, repoRoot: string | undefined): void {
  // Scaffold a new project. The welcome buttons pass the mode; the palette asks.
  reg(context, 'spec2integration.newProject', async (mode?: Mode) => {
    let m = mode;
    if (m !== 'greenfield' && m !== 'biztalk') {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(sparkle) Greenfield', detail: 'Start from a PRD or brief', mode: 'greenfield' as Mode },
          { label: '$(history) BizTalk migration', detail: 'Reverse-engineer a BizTalk solution', mode: 'biztalk' as Mode },
        ],
        { title: 'New Spec2Integration project', placeHolder: 'Choose a starting point' },
      );
      if (!pick) return;
      m = pick.mode;
    }
    await newProject(context, m);
  });

  // Hybrid refresh: overlay the latest assets from GitHub onto this workspace.
  reg(context, 'spec2integration.updateAssets', async () => {
    if (!repoRoot) {
      vscode.window.showWarningMessage('Open a Spec2Integration workspace before updating its assets.');
      return;
    }
    const manifest = await readManifest(context);
    const confirm = await vscode.window.showInformationMessage(
      `Update .claude agents/skills/commands, schemas, templates and scripts from GitHub?` +
        (manifest ? ` (bundled snapshot: v${manifest.version}${manifest.git ? ' @ ' + manifest.git : ''})` : '') +
        ' This requires network access and overwrites local copies of those files.',
      { modal: true },
      'Update',
    );
    if (confirm !== 'Update') return;
    try {
      const { written, ref } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Updating pipeline assets from GitHub…' },
        () => updateAssetsFromGitHub(repoRoot),
      );
      vscode.window.showInformationMessage(`Updated ${written} pipeline asset file(s) from ${ref}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`Asset update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Start a BizTalk migration: pick the source folder, then kick it off in chat.
  reg(context, 'spec2integration.startBizTalkMigration', async () => {
    if (!repoRoot) {
      vscode.window.showWarningMessage('Open a Spec2Integration workspace before starting a migration.');
      return;
    }
    await startBizTalkMigration(context, repoRoot);
  });

  // Reset the reused pipeline session so the next command mints a fresh one.
  reg(context, 'spec2integration.resetSession', async () => {
    if (!getSessionId()) {
      vscode.window.showInformationMessage('No reused Claude Code session is set for this workspace.');
      return;
    }
    await setSessionId(undefined);
    vscode.window.showInformationMessage('Pipeline chat session reset — the next command will start a new one.');
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const repoRoot = resolveRepoRoot();
  initSessionStore(context);
  registerLauncherCommands(context, repoRoot);
  void vscode.commands.executeCommand('setContext', 'spec2integration.noWorkspace', !repoRoot);

  if (!repoRoot) {
    // No workspace — register an (empty) tree so the welcome view renders its
    // Greenfield / BizTalk launcher buttons. Everything else needs a folder.
    const empty = new PipelineTreeProvider('');
    context.subscriptions.push(
      vscode.window.createTreeView('spec2integration.pipeline', { treeDataProvider: empty }),
    );
    return;
  }

  const tree = new PipelineTreeProvider(repoRoot);
  const treeView = vscode.window.createTreeView('spec2integration.pipeline', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Compose any command from the catalog.
  reg(context, 'spec2integration.composeCommand', async () => {
    const cmd = await pickCommand();
    if (!cmd) return;
    await composeAndSend(repoRoot, cmd);
  });

  // Run the recommended next step for an integration (from status.json.next).
  reg(context, 'spec2integration.runNext', async (node?: IntegrationNode) => {
    const folder = node?.folder ?? (await defaultFolder(repoRoot));
    if (!folder) {
      vscode.window.showWarningMessage('No integration selected and no active integration set.');
      return;
    }
    const status = node?.status ?? (await readStatus(repoRoot, folder));
    const nextCommand = status?.next?.command;
    if (!nextCommand) {
      vscode.window.showInformationMessage(`No recommended next step recorded for ${folder}.`);
      return;
    }
    // next.command already includes the folder arg; send it verbatim so the
    // recommendation (including its reason) is honored exactly.
    await sendToChat(nextCommand);
  });

  // Continue a BizTalk pre-integration: author spec → contracts → IR from the
  // existing inventory. /biztalk-reverse-engineer reuses the already-written
  // specs/<domain>/biztalk-inventory.md, so no source-folder pick is needed.
  reg(context, 'spec2integration.runReverseEngineer', async () => {
    await sendToChat('/biztalk-reverse-engineer');
  });

  // Set / change the BizTalk source folder (no chat command — just records where
  // the solution lives). The welcome button flips to "Run Pipeline" once set.
  reg(context, 'spec2integration.setBiztalkSource', async () => {
    const defaultDir = await resolveSourceDefault(context, repoRoot);
    const picked = await vscode.window.showOpenDialog({
      title: 'Specify the BizTalk source folder (the folder with the .btproj files, or an MSI export)',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(defaultDir),
      openLabel: 'Set as BizTalk source',
    });
    if (!picked || picked.length === 0) return;
    await context.workspaceState.update(BIZTALK_SOURCE_KEY, picked[0].fsPath);
    if (await containsBtproj(picked[0].fsPath)) {
      vscode.window.showInformationMessage(`BizTalk source set: ${picked[0].fsPath}. Click "Run Pipeline" to start the migration.`);
    } else {
      vscode.window.showWarningMessage(
        `BizTalk source set to ${picked[0].fsPath}, but no .btproj was found under it. Make sure this is the solution root (or an MSI export) before running the pipeline.`,
      );
    }
    await updateBiztalkSourceContext(context, repoRoot);
    tree.refresh();
  });

  // Analyse only (stage 1): inventory + catalogue. Groups then appear under the
  // BizTalk node, where Run Pipeline migrates the one you pick.
  reg(context, 'spec2integration.analyseSolution', async () => {
    const src = await resolveBiztalkSource(context, repoRoot);
    if (!src) return;
    await sendToChat(`/biztalk-inventory ${quoteArg(src)}`);
  });

  // Run the orchestrator. BizTalk is adaptive: analyse first if the solution
  // isn't catalogued yet; once catalogued, pick a single group (or All) then the
  // option checkboxes. Greenfield just collects the option checkboxes.
  reg(context, 'spec2integration.runFullPipeline', async () => {
    const mode = await detectMode(repoRoot);

    if (mode === 'biztalk') {
      const src = await resolveBiztalkSource(context, repoRoot);
      if (!src) return;
      const token = quoteArg(src);

      // Is the solution analysed yet (catalogue with groups)?
      const sols = await discoverBiztalkSolutions(repoRoot);
      const sol = sols.find((s) => s.groups.length > 0) ?? sols[0];
      const groups = sol?.groups ?? [];

      if (groups.length === 0) {
        // Not analysed — run inventory only; groups then appear in the panel.
        vscode.window.showInformationMessage(
          'Analysing the BizTalk solution first (inventory + catalogue). Each integration group will then appear under the BizTalk node — run this again to pick one to migrate.',
        );
        await sendToChat(`/biztalk-inventory ${token}`);
        return;
      }

      // Analysed — pick a single group (or the whole solution).
      const groupItems = [
        { label: '$(layers) All groups (one combined integration)', detail: 'migrate the whole solution at once', id: '__all__' },
        ...groups.map((g) => ({
          label: `${g.id}  ${g.name}`,
          detail: g.migrated ? 'already migrated — re-run to regenerate' : 'not migrated',
          id: g.id,
        })),
      ];
      const groupPick = await vscode.window.showQuickPick(groupItems, {
        title: 'Migrate which integration group?',
        placeHolder: 'Pick one group → its own integration, or All → one combined integration',
      });
      if (!groupPick) return;

      const flags = await pickPipelineFlags(mode);
      if (flags === undefined) return;
      const groupArg = groupPick.id === '__all__' ? '' : ` --group ${groupPick.id}`;
      await sendToChat(`/run-pipeline --mode biztalk --input ${token}${groupArg}${flags}`);
      return;
    }

    const flags = await pickPipelineFlags(mode);
    if (flags === undefined) return;
    await sendToChat(`/run-pipeline --mode ${mode}${flags}`);
  });

  // Migrate a single BizTalk catalogue group: scope the unattended pipeline to it.
  // The chat preview box (previewBeforeSend, on by default) is the confirm/customize
  // point — the user can drop --unattended or add --auto-fix N before it sends.
  reg(context, 'spec2integration.migrateGroup', async (node?: BiztalkGroupNode) => {
    const group = node?.group;
    if (!group) {
      vscode.window.showWarningMessage('No BizTalk group selected.');
      return;
    }
    const src = await resolveBiztalkSource(context, repoRoot);
    if (!src) return;
    await sendToChat(`/run-pipeline --mode biztalk --input ${quoteArg(src)} --unattended --group ${group.id}`);
  });

  // Open a deployed app's live URL in the browser (from a done Deploy stage row).
  reg(context, 'spec2integration.openDeployedUrl', async (node?: StageNode) => {
    const url = node?.deployedUrl;
    if (!url) {
      vscode.window.showWarningMessage('No deployed URL recorded for this stage yet.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  // Deploy an integration (stage 3). Provisions + deploys via azd.
  reg(context, 'spec2integration.deploy', async (node?: IntegrationNode) => {
    const folder = node?.folder ?? (await defaultFolder(repoRoot));
    if (!folder) {
      vscode.window.showWarningMessage('No integration selected and no active integration set.');
      return;
    }
    await sendToChat(`/deploy-azure ${folder}`);
  });

  // Run a specific pipeline stage's command (from a tree stage row).
  reg(context, 'spec2integration.runStage', async (node?: StageNode) => {
    if (!node || !node.stageCommand) return;
    const cmd = findCommand(node.stageCommand);
    if (!cmd) {
      vscode.window.showErrorMessage(`Unknown command ${node.stageCommand}.`);
      return;
    }
    await composeAndSend(repoRoot, cmd, node.folder);
  });

  // Pin the active integration (writes .spec2integration/state.json via /use in chat).
  reg(context, 'spec2integration.setActive', async (node?: IntegrationNode) => {
    const folder = node?.folder;
    if (!folder) return;
    await sendToChat(`/use ${folder}`);
  });

  reg(context, 'spec2integration.openVisualizer', async (node?: IntegrationNode) => {
    const folder = node?.folder ?? (await defaultFolder(repoRoot));
    await openVisualizer(context, repoRoot, folder);
  });

  // Live pipeline progress cockpit for an integration.
  reg(context, 'spec2integration.openProgress', async (node?: IntegrationNode) => {
    await openProgress(context, repoRoot, node?.folder ?? (await defaultFolder(repoRoot)));
  });

  // Open a stage's primary artifact (file in an editor, directory in the explorer).
  reg(context, 'spec2integration.openArtifact', async (node?: StageNode) => {
    if (!node?.artifactRel) return;
    await openPath(repoRoot, node.folder, node.artifactRel);
  });

  // Open a stage's artifact in its richest rendered view: the IR opens in the
  // graph visualizer; Markdown opens in the Markdown preview.
  reg(context, 'spec2integration.previewArtifact', async (node?: StageNode) => {
    if (!node?.artifactRel) return;
    if (/integration-ir\.ya?ml$/i.test(node.artifactRel)) {
      await openVisualizer(context, repoRoot, node.folder);
      return;
    }
    await openPreview(repoRoot, node.folder, node.artifactRel);
  });

  // Jump to the report that explains a blocked / findings state.
  reg(context, 'spec2integration.openReport', async (node?: StageNode) => {
    if (!node?.reportRel) return;
    await openPath(repoRoot, node.folder, node.reportRel);
  });

  // Open a domain's domain.yaml.
  reg(context, 'spec2integration.openDomain', async (node?: DomainNode) => {
    if (!node?.domainYaml) return;
    await openPath(repoRoot, '.', node.domainYaml);
  });

  reg(context, 'spec2integration.refresh', () => tree.refresh());

  // Status bar: active integration + recommended next step, click to run it.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'spec2integration.runNext';
  context.subscriptions.push(statusBar);
  const refreshAll = () => {
    tree.refresh();
    void updateStatusBar(repoRoot, statusBar);
    void updateHasIntegrationsContext(repoRoot);
    void updateIsBiztalkContext(repoRoot);
    void updateBiztalkSourceContext(context, repoRoot);
    // Re-decorate an open visualizer / progress view when status.json changes.
    void refreshVisualizer(repoRoot);
    void refreshProgress(repoRoot);
    // Raise stage-completion / Sev-1 notifications on meaningful transitions.
    void checkNotifications(repoRoot);
  };

  // Live updates: watch status.json files and the global state file. Also watch
  // the BizTalk inventory/catalogue so the pre-integration card appears the
  // moment /biztalk-inventory writes them (before any status.json exists).
  const statusWatcher = vscode.workspace.createFileSystemWatcher('**/specs/**/status.json');
  const stateWatcher = vscode.workspace.createFileSystemWatcher('**/.spec2integration/state.json');
  const inventoryWatcher = vscode.workspace.createFileSystemWatcher(
    '**/specs/**/{biztalk-inventory,integration-catalogue}.md',
  );
  for (const w of [statusWatcher, stateWatcher, inventoryWatcher]) {
    w.onDidCreate(refreshAll);
    w.onDidChange(refreshAll);
    w.onDidDelete(refreshAll);
    context.subscriptions.push(w);
  }

  // Belt-and-suspenders. File-system watchers can silently miss creation events
  // on network- or OneDrive-redirected corporate paths, which would leave the
  // "No integrations found yet" welcome up after the chat has already written the
  // first status.json. Re-discover whenever the panel becomes visible or the
  // window regains focus (e.g. switching back from the Claude Code chat once a
  // stage completed) — refreshAll only reads a few JSON files, and
  // checkNotifications primes silently, so this never toasts on a no-op.
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) refreshAll();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) refreshAll();
    }),
  );

  // Initial paint + IR schema IntelliSense registration.
  refreshAll();
  void registerIrSchema(repoRoot);

  // If this workspace was just scaffolded, open its walkthrough and offer step 1.
  void offerFirstStepIfPending(context, repoRoot, sendToChat);
}

async function updateStatusBar(repoRoot: string, item: vscode.StatusBarItem): Promise<void> {
  const state = await readState(repoRoot);
  const folder = state.activeIntegration;
  if (!folder) {
    item.hide();
    return;
  }
  const status = await readStatus(repoRoot, folder);
  const slug = folder.split('/').pop() ?? folder;
  const nextCmd = status?.next?.command;
  const nextToken = nextCmd?.split(/\s+/)[0];
  item.text = `$(rocket) ${slug}${nextToken ? ` · ${nextToken}` : ''}`;
  item.tooltip = nextCmd
    ? `Spec2Integration — next: ${nextCmd}${status?.next?.reason ? `\n${status.next.reason}` : ''}\nClick to send to chat.`
    : `Spec2Integration — active: ${folder}`;
  item.show();
}

const BIZTALK_SOURCE_KEY = 'spec2integration.biztalkSourcePath';

/** Read the `- **Solution path:** <path>` header from any biztalk-inventory.md in
 *  the workspace — the folder the existing inventory was actually built from. */
async function readInventorySolutionPath(repoRoot: string): Promise<string | undefined> {
  for (const sol of await discoverBiztalkSolutions(repoRoot)) {
    if (!sol.inventoryRel) continue;
    try {
      const text = await fs.readFile(path.join(repoRoot, sol.folder, sol.inventoryRel), 'utf-8');
      const m = /^-\s*\*\*Solution path:\*\*\s*(.+?)\s*$/m.exec(text);
      const p = m?.[1]?.trim();
      if (p && p !== '<path>' && (await pathExists(p))) return p;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * Resolve the folder the source picker should open at. Prefer, in order: the
 * last folder the user picked, the folder the existing inventory was built from
 * (the inventory header), the project's `source/` drop spot ONLY if it actually
 * holds a `.btproj`, then the repo root. This stops the picker defaulting to an
 * empty scaffold `source/` when the real BizTalk solution lives elsewhere.
 */
async function resolveSourceDefault(context: vscode.ExtensionContext, repoRoot: string): Promise<string> {
  const last = context.workspaceState.get<string>(BIZTALK_SOURCE_KEY);
  if (last && (await pathExists(last))) return last;
  const fromInventory = await readInventorySolutionPath(repoRoot);
  if (fromInventory) return fromInventory;
  const sourceDir = path.join(repoRoot, 'source');
  if (await containsBtproj(sourceDir)) return sourceDir;
  return repoRoot;
}

/** Shallow scan (≤3 levels) for any `.btproj` under a directory. */
async function containsBtproj(dir: string): Promise<boolean> {
  let frontier: string[] = [dir];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: string[] = [];
    for (const cur of frontier) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.btproj')) return true;
        if (e.isDirectory() && !e.name.startsWith('.')) next.push(path.join(cur, e.name));
      }
    }
    frontier = next;
  }
  return false;
}

/** Quote a CLI argument when it contains whitespace. */
function quoteArg(p: string): string {
  return /\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

/** Multi-select option checkboxes for /run-pipeline. Returns the assembled flag
 *  string (leading space, or empty) — or undefined if the user cancelled. */
async function pickPipelineFlags(mode: string): Promise<string | undefined> {
  const flagItems = [
    { label: 'Unattended', description: '--unattended', detail: 'auto-accept clarifications + allow Sev-2 + auto-fix ×3 (hands-off / CI)', flag: '--unattended', picked: true },
    { label: 'Auto-fix', description: '--auto-fix', detail: 'self-healing loop: route findings back to the owning agent and re-run', flag: '--auto-fix' },
    { label: 'Allow Sev-2', description: '--allow-sev2', detail: 'proceed while Sev-2 findings are tracked (Sev-1 always blocks)', flag: '--allow-sev2' },
    { label: 'Auto-accept clarifications', description: '--auto-accept-clarifications', detail: "use the clarifier's recommended answers (no human sign-off)", flag: '--auto-accept-clarifications' },
    { label: 'Dry run', description: '--dry-run', detail: 'print the planned command sequence and exit without running', flag: '--dry-run' },
  ];
  const picks = await vscode.window.showQuickPick(flagItems, {
    canPickMany: true,
    title: `Pipeline options — ${mode} (stops before deploy)`,
    placeHolder: 'Toggle with Space, Enter to run. Unattended already implies auto-fix + allow Sev-2 + auto-accept.',
  });
  if (picks === undefined) return undefined;
  const set = new Set(picks.map((p) => p.flag));
  if (set.has('--unattended')) return set.has('--dry-run') ? ' --unattended --dry-run' : ' --unattended';
  let flags = '';
  for (const f of ['--auto-accept-clarifications', '--allow-sev2', '--auto-fix', '--dry-run']) {
    if (set.has(f)) flags += ` ${f}`;
  }
  return flags;
}

/**
 * The BizTalk solution folder to use for a run, WITHOUT forcing the explicit
 * picker every time: the persisted choice (if it still holds a `.btproj`), else
 * the folder the existing inventory was built from, else prompt with a folder
 * picker (and persist). Returns undefined only if the user cancels the picker.
 */
async function resolveBiztalkSource(context: vscode.ExtensionContext, repoRoot: string): Promise<string | undefined> {
  const last = context.workspaceState.get<string>(BIZTALK_SOURCE_KEY);
  if (last && (await pathExists(last)) && (await containsBtproj(last))) return last;
  const fromInventory = await readInventorySolutionPath(repoRoot);
  if (fromInventory) return fromInventory;

  const defaultDir = await resolveSourceDefault(context, repoRoot);
  const picked = await vscode.window.showOpenDialog({
    title: 'Select the BizTalk source folder to migrate (the folder containing the .btproj / solution)',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(defaultDir),
    openLabel: 'Use this source folder',
  });
  if (!picked || picked.length === 0) return undefined;
  await context.workspaceState.update(BIZTALK_SOURCE_KEY, picked[0].fsPath);
  if (!(await containsBtproj(picked[0].fsPath))) {
    const proceed = await vscode.window.showWarningMessage(
      `No .btproj found under ${picked[0].fsPath}. This may not be a BizTalk solution folder — the migration needs the folder that contains the .btproj files. Continue anyway?`,
      { modal: true },
      'Continue',
    );
    if (proceed !== 'Continue') return undefined;
  }
  return picked[0].fsPath;
}

/**
 * Open a folder picker (defaulting to the real BizTalk source — last-used, then
 * the inventory's recorded path, then a `source/` that actually holds a `.btproj`)
 * and start the BizTalk migration in chat. The user chooses between the full
 * reverse-engineer (which creates the `specs/biztalk/NNN-slug` integration
 * project) and inventory-only (review first). Both pass the chosen source folder
 * as the command argument — so the source is always picked explicitly. The
 * choice is persisted so later runs default to it.
 */
async function startBizTalkMigration(context: vscode.ExtensionContext, repoRoot: string): Promise<void> {
  const defaultDir = await resolveSourceDefault(context, repoRoot);
  const picked = await vscode.window.showOpenDialog({
    title: 'Select the BizTalk source folder to migrate (the folder containing the .btproj / solution)',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(defaultDir),
    openLabel: 'Use this source folder',
  });
  if (!picked || picked.length === 0) return;

  // Persist the choice so the next migration defaults here, not to an empty source/.
  await context.workspaceState.update(BIZTALK_SOURCE_KEY, picked[0].fsPath);

  if (!(await containsBtproj(picked[0].fsPath))) {
    const proceed = await vscode.window.showWarningMessage(
      `No .btproj found under ${picked[0].fsPath}. This may not be a BizTalk solution folder — the inventory needs the folder that contains the .btproj files. Continue anyway?`,
      { modal: true },
      'Continue',
    );
    if (proceed !== 'Continue') return;
  }

  // Prefer a repo-relative POSIX path when the selection is inside the workspace.
  const rel = path.relative(repoRoot, picked[0].fsPath).split(path.sep).join('/');
  const arg = rel && !rel.startsWith('..') ? rel : picked[0].fsPath;
  const token = /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;

  const action = await vscode.window.showQuickPick(
    [
      {
        label: '$(rocket) Full reverse-engineer',
        detail: 'inventory → spec → contracts → IR — creates the integration project',
        cmd: '/biztalk-reverse-engineer',
      },
      {
        label: '$(list-tree) Inventory only (Analyse)',
        detail: 'catalog the solution first; review before reverse-engineering',
        cmd: '/biztalk-inventory',
      },
    ],
    { title: 'Start BizTalk migration', placeHolder: `Source: ${arg}` },
  );
  if (!action) return;
  await sendToChat(`${action.cmd} ${token}`);
}

/** Set the `spec2integration.isBiztalk` context key so BizTalk-only UI (the
 *  Start Migration button) shows for migration workspaces. Keys off the scaffold
 *  mode recorded in `.spec2integration/assets-version.json`, falling back to the
 *  presence of a top-level `source/` folder (the BizTalk scaffold's hallmark). */
async function updateIsBiztalkContext(repoRoot: string): Promise<void> {
  let isBiztalk = false;
  try {
    const raw = await fs.readFile(path.join(repoRoot, '.spec2integration', 'assets-version.json'), 'utf-8');
    isBiztalk = JSON.parse(raw)?.mode === 'biztalk';
  } catch {
    isBiztalk = false;
  }
  if (!isBiztalk) isBiztalk = await pathExists(path.join(repoRoot, 'source'));
  await vscode.commands.executeCommand('setContext', 'spec2integration.isBiztalk', isBiztalk);
}

/** Best-effort pipeline mode for this workspace: the scaffold mode recorded in
 *  `.spec2integration/assets-version.json`, else `biztalk` if a `source/` folder
 *  exists, else `greenfield`. Used to pre-fill `/run-pipeline --mode`. */
async function detectMode(repoRoot: string): Promise<'biztalk' | 'greenfield'> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, '.spec2integration', 'assets-version.json'), 'utf-8');
    const m = JSON.parse(raw)?.mode;
    if (m === 'biztalk' || m === 'greenfield') return m;
  } catch {
    /* fall through */
  }
  return (await pathExists(path.join(repoRoot, 'source'))) ? 'biztalk' : 'greenfield';
}

/** Drive the welcome button: `spec2integration.biztalkSourceSet` is true once a
 *  source folder is persisted (and still exists) or an inventory header records one.
 *  When false the welcome shows "Specify BizTalk Source Folder"; when true, "Run Pipeline". */
async function updateBiztalkSourceContext(context: vscode.ExtensionContext, repoRoot: string): Promise<void> {
  const last = context.workspaceState.get<string>(BIZTALK_SOURCE_KEY);
  let isSet = !!(last && (await pathExists(last)));
  if (!isSet) isSet = !!(await readInventorySolutionPath(repoRoot));
  await vscode.commands.executeCommand('setContext', 'spec2integration.biztalkSourceSet', isSet);
}

async function updateHasIntegrationsContext(repoRoot: string): Promise<void> {
  let has = false;
  try {
    has = await pathExists(path.join(repoRoot, 'specs'));
  } catch {
    has = false;
  }
  await vscode.commands.executeCommand('setContext', 'spec2integration.hasSpecs', has);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function deactivate(): void {
  /* nothing to clean up beyond subscriptions */
}
