// New-project scaffolding.
//
// Invoked from the no-workspace welcome view. Lays the bundled pipeline assets
// (mode-filtered) into a fresh folder, writes a sanitized .claude/settings.json
// and a .spec2integration/ seed, records the first step to offer once the folder
// reopens, then opens it. Claude Code auto-loads `.claude/` from the workspace
// root, so the chat side is ready the moment the window reloads.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { Mode, copyAssets, readManifest } from './assets';

/** globalState key holding the first step to offer for a freshly scaffolded path. */
export const PENDING_KEY = 'spec2integration.pendingFirstStep';

export interface PendingFirstStep {
  mode: Mode;
  /** Slash command to offer once the new folder opens. */
  firstStep: string;
  /** Walkthrough id to surface for this path. */
  walkthrough: string;
}

const FIRST_STEP: Record<Mode, string> = {
  greenfield: '/draft-prd',
  // BizTalk's first step is delivered via the source-folder picker
  // (spec2integration.startBizTalkMigration), not by sending this string
  // directly — reverse-engineer is the entry point that creates the project.
  biztalk: '/biztalk-reverse-engineer',
};

// Fully-qualified walkthrough ids: `${publisher}.${name}#${walkthroughId}`.
const WALKTHROUGH: Record<Mode, string> = {
  greenfield: 'spec2integration.spec2integration#gettingStarted.greenfield',
  biztalk: 'spec2integration.spec2integration#gettingStarted.biztalk',
};

/** Resolve the PowerShell executable available on this machine, if any. */
function detectPwsh(): Promise<'pwsh' | 'powershell' | null> {
  const probe = (exe: string): Promise<boolean> =>
    new Promise((resolve) => {
      try {
        const p = spawn(exe, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('exit', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  return (async () => {
    if (await probe('pwsh')) return 'pwsh';
    if (process.platform === 'win32' && (await probe('powershell'))) return 'powershell';
    return null;
  })();
}

/** Build the .claude/settings.json text — adds the staleness hook only when a
 *  PowerShell runtime exists, so a fresh mac/Linux project never logs a failing
 *  hook on every edit. */
async function buildSettings(context: vscode.ExtensionContext, pwsh: 'pwsh' | 'powershell' | null): Promise<string> {
  const tmplPath = path.join(context.extensionUri.fsPath, 'assets-templates', 'settings.json');
  const base = JSON.parse(await fs.readFile(tmplPath, 'utf-8'));
  if (pwsh) {
    const cmd =
      pwsh === 'pwsh'
        ? 'pwsh -NoProfile -File ./scripts/refresh-status.ps1'
        : 'powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/refresh-status.ps1';
    base.hooks = {
      PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: cmd }] }],
    };
  }
  return JSON.stringify(base, null, 2) + '\n';
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Slugify a project name into an NNN-style-free folder leaf. */
function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'integration'
  );
}

/**
 * Run the new-project flow for `mode`. Returns the created folder Uri, or
 * undefined if the user cancelled.
 */
export async function newProject(context: vscode.ExtensionContext, mode: Mode): Promise<vscode.Uri | undefined> {
  const parent = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Select parent folder',
    title: `New ${mode === 'biztalk' ? 'BizTalk migration' : 'greenfield'} integration project — choose a parent folder`,
  });
  if (!parent || parent.length === 0) return undefined;

  const name = await vscode.window.showInputBox({
    title: 'Project name',
    prompt: 'A new sub-folder with this name is created in the selected parent.',
    value: mode === 'biztalk' ? 'biztalk-migration' : 'my-integration',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a project name'),
  });
  if (name === undefined) return undefined;

  const target = path.join(parent[0].fsPath, slugify(name));
  if (await pathExists(target)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${target} already exists. Scaffold into it anyway?`,
      { modal: true },
      'Scaffold here',
    );
    if (overwrite !== 'Scaffold here') return undefined;
  }

  const manifest = await readManifest(context);
  const pwsh = await detectPwsh();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating ${mode} project…` },
    async (progress) => {
      progress.report({ message: 'copying agents, skills, commands…' });
      await fs.mkdir(target, { recursive: true });
      const copied = await copyAssets(context, mode, target);

      progress.report({ message: 'writing settings & state…' });
      await fs.mkdir(path.join(target, '.claude'), { recursive: true });
      await fs.writeFile(path.join(target, '.claude', 'settings.json'), await buildSettings(context, pwsh));

      await fs.mkdir(path.join(target, '.spec2integration'), { recursive: true });
      const seedPath = path.join(context.extensionUri.fsPath, 'assets-templates', 'state.seed.json');
      await fs.copyFile(seedPath, path.join(target, '.spec2integration', 'state.json'));
      await fs.writeFile(
        path.join(target, '.spec2integration', 'assets-version.json'),
        JSON.stringify(
          { source: 'bundled', version: manifest?.version, git: manifest?.git, mode, scaffoldedAt: new Date().toISOString(), fileCount: copied },
          null,
          2,
        ) + '\n',
      );

      await fs.mkdir(path.join(target, 'specs'), { recursive: true });
      if (mode === 'biztalk') {
        // A conventional drop spot — optional. The source folder is chosen when
        // the migration is kicked off (Start BizTalk Migration), and may live
        // anywhere on disk; it is not copied or required at creation time.
        const srcDir = path.join(target, 'source');
        await fs.mkdir(srcDir, { recursive: true });
        await fs.writeFile(
          path.join(srcDir, 'README.md'),
          [
            '# BizTalk source (optional drop spot)',
            '',
            'You do not have to put anything here. When you run **Start BizTalk',
            'Migration** from the Spec2Integration panel you browse to your BizTalk',
            'source folder (MSI export or exploded solution) wherever it lives — that',
            'is when the source is selected.',
            '',
            'If you prefer to keep the source inside the project, drop the BizTalk',
            'application MSI (BTSTask ExportApp output) or the exploded solution',
            '(orchestrations, maps, schemas, pipelines, bindings, BRE policies) here',
            'and point the migration at this `source/` folder.',
            '',
          ].join('\n'),
        );
      }
    },
  );

  const pending: PendingFirstStep = { mode, firstStep: FIRST_STEP[mode], walkthrough: WALKTHROUGH[mode] };
  await context.globalState.update(`${PENDING_KEY}.${target}`, pending);

  if (!pwsh) {
    void vscode.window.showInformationMessage(
      'No PowerShell (pwsh) found — the automatic status-refresh hook was left out. ' +
        'Run `/status <folder>` to refresh pipeline staleness, or install PowerShell 7 and re-enable the hook in .claude/settings.json.',
    );
  }

  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: false });
  return vscode.Uri.file(target);
}

/**
 * On activation, if this workspace was just scaffolded, open the matching
 * walkthrough and offer the first command. Consumes the one-time flag so it
 * fires exactly once.
 */
export async function offerFirstStepIfPending(
  context: vscode.ExtensionContext,
  repoRoot: string,
  sendToChat: (prompt: string) => Promise<void>,
): Promise<void> {
  const key = `${PENDING_KEY}.${repoRoot}`;
  const pending = context.globalState.get<PendingFirstStep>(key);
  if (!pending) return;
  await context.globalState.update(key, undefined); // fire once

  void vscode.commands.executeCommand('workbench.action.openWalkthrough', pending.walkthrough, false);

  const isBiztalk = pending.mode === 'biztalk';
  const run = isBiztalk ? 'Start migration' : `Start: ${pending.firstStep}`;
  const message = isBiztalk
    ? "Project ready. Start the BizTalk migration? You'll browse to your source folder, then Claude Code inventories it and builds the spec, contracts and IR — the pipeline tree appears as it runs."
    : `Project ready. Begin the greenfield pipeline with ${pending.firstStep}?`;
  const choice = await vscode.window.showInformationMessage(message, run, 'Not now');
  if (choice !== run) return;
  // BizTalk: route through the source-folder picker (Start BizTalk Migration) so
  // the source is selected at kickoff and the reverse-engineer entry point — the
  // one that creates the integration project — runs against it; the pipeline tree
  // appears once its status.json is written. Greenfield: send /draft-prd.
  if (isBiztalk) {
    await vscode.commands.executeCommand('spec2integration.startBizTalkMigration');
  } else {
    await sendToChat(pending.firstStep);
  }
}
