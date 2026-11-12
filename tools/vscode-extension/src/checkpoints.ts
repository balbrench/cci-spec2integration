// Per-stage checkpoints — the VS Code side of Phase 4, Change 2.
//
// Before the extension sends a stage command (tree row, stage graph, Run Next),
// it checkpoints the integration folder (checkpointCore.ts). Stage rows then
// offer Compare with last checkpoint, Revert this stage's run, and Checkpoint
// history. Checkpoint data lives in the extension's per-workspace storage plus
// private git refs; nothing is written to the pipeline's folders (Article VIII).
//
// Settings: spec2integration.checkpoints.enabled (default on),
//           spec2integration.checkpoints.keep (default 5 per stage).

import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  Checkpoint,
  CheckpointDiff,
  changedCount,
  createCheckpoint,
  deleteCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  pruneCheckpoints,
  readEntry,
  revertCheckpoint,
} from './checkpointCore';

let storeDir: string | undefined;
let repoRootDir: string | undefined;
/** Latest checkpoint per folder + stage, refreshed after every create / delete. */
let latest = new Map<string, Checkpoint>();
/** Changed-file counts, keyed by checkpoint id + a token that changes when the folder changes. */
const countCache = new Map<string, { token: string; changed: number }>();
let onChanged: (() => void) | undefined;

const key = (folder: string, stageId: string) => `${folder}\0${stageId}`;

function cfg() {
  const c = vscode.workspace.getConfiguration('spec2integration');
  return { enabled: c.get<boolean>('checkpoints.enabled', true), keep: c.get<number>('checkpoints.keep', 5) };
}

async function reindex(): Promise<void> {
  if (!storeDir) return;
  const next = new Map<string, Checkpoint>();
  for (const cp of await listCheckpoints(storeDir)) {
    const k = key(cp.folder, cp.stageId);
    if (!next.has(k)) next.set(k, cp); // list is newest first
  }
  latest = next;
  onChanged?.();
}

export async function initCheckpoints(context: vscode.ExtensionContext, repoRoot: string, changed: () => void): Promise<void> {
  if (!context.storageUri) return;
  storeDir = context.storageUri.fsPath;
  repoRootDir = repoRoot;
  onChanged = changed;
  await fs.mkdir(storeDir, { recursive: true });
  await reindex();
}

/** Checkpoint `folder` before a stage command is sent. Never blocks the send. */
export async function checkpointBeforeRun(folder: string, stageId: string, command: string): Promise<void> {
  if (!storeDir || !repoRootDir || !cfg().enabled) return;
  const repoRoot = repoRootDir;
  const store = storeDir;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Checkpointing ${folder} before ${command}…` },
      async () => {
        await createCheckpoint({ repoRoot, folder, stageId, command, storeDir: store });
        await pruneCheckpoints(repoRoot, store, cfg().keep);
      },
    );
    await reindex();
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Spec2Integration: could not checkpoint ${folder} before ${command}, so this run cannot be reverted from the tree. ${(err as Error).message}`,
    );
  }
}

/** For stage rows: when the latest checkpoint was taken and how many files changed since. */
export async function checkpointInfo(
  folder: string,
  stageId: string,
  token: string,
): Promise<{ at: string; changed?: number } | undefined> {
  const cp = latest.get(key(folder, stageId));
  if (!cp || !storeDir || !repoRootDir) return undefined;
  const cached = countCache.get(cp.id);
  if (cached && cached.token === token) return { at: cp.createdAt, changed: cached.changed };
  try {
    const changed = changedCount(await diffCheckpoint(repoRootDir, storeDir, cp));
    countCache.set(cp.id, { token, changed });
    return { at: cp.createdAt, changed };
  } catch {
    return { at: cp.createdAt };
  }
}

function describe(d: CheckpointDiff): string[] {
  return [
    ...d.modified.map((p) => `restore  ${p}`),
    ...d.removed.map((p) => `recreate ${p}`),
    ...d.added.map((p) => `delete   ${p}`),
  ];
}

async function pickCheckpoint(folder: string, stageId?: string): Promise<Checkpoint | undefined> {
  if (!storeDir) return undefined;
  const all = (await listCheckpoints(storeDir, folder)).filter((c) => !stageId || c.stageId === stageId);
  if (all.length === 0) {
    vscode.window.showInformationMessage(`No checkpoints for ${folder}${stageId ? ' stage ' + stageId : ''} yet. One is taken each time you run a stage from the tree or the stage graph.`);
    return undefined;
  }
  if (stageId && all.length >= 1) return all[0];
  const pick = await vscode.window.showQuickPick(
    all.map((c) => ({ label: `${c.stageId}  ${c.command}`, description: new Date(c.createdAt).toLocaleString(), cp: c })),
    { title: `Checkpoints for ${folder}`, placeHolder: 'Newest first' },
  );
  return pick?.cp;
}

/** Write a captured file to a temp location so it can be shown in a diff editor. */
async function capturedUri(cp: Checkpoint, rel: string): Promise<vscode.Uri> {
  const entry = cp.entries.find((e) => e.path === rel)!;
  const bytes = await readEntry(repoRootDir!, storeDir!, cp, entry);
  const file = path.join(os.tmpdir(), 'spec2integration-checkpoints', cp.id, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return vscode.Uri.file(file);
}

export async function compareCheckpoint(folder: string, stageId?: string): Promise<void> {
  const cp = await pickCheckpoint(folder, stageId);
  if (!cp) return;
  const d = await diffCheckpoint(repoRootDir!, storeDir!, cp);
  const items = [
    ...d.modified.map((p) => ({ label: `$(diff) ${p}`, description: 'changed', p, change: 'modified' as const })),
    ...d.added.map((p) => ({ label: `$(add) ${p}`, description: 'created by the run', p, change: 'added' as const })),
    ...d.removed.map((p) => ({ label: `$(trash) ${p}`, description: 'deleted by the run', p, change: 'removed' as const })),
  ];
  if (items.length === 0) {
    vscode.window.showInformationMessage(`No files in ${folder} have changed since the ${cp.command} checkpoint (${new Date(cp.createdAt).toLocaleString()}).`);
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: `${items.length} file(s) changed since the ${cp.command} checkpoint (${new Date(cp.createdAt).toLocaleString()})`,
    placeHolder: 'Pick a file to see its diff',
  });
  if (!pick) return;
  const current = vscode.Uri.file(path.join(repoRootDir!, folder, pick.p));
  if (pick.change === 'modified') {
    await vscode.commands.executeCommand('vscode.diff', await capturedUri(cp, pick.p), current, `${pick.p} (checkpoint ↔ now)`);
  } else if (pick.change === 'added') {
    await vscode.window.showTextDocument(current);
  } else {
    await vscode.window.showTextDocument(await capturedUri(cp, pick.p), { preview: true });
  }
}

export async function revertStage(folder: string, stageId?: string): Promise<void> {
  const cp = await pickCheckpoint(folder, stageId);
  if (!cp) return;
  const d = await diffCheckpoint(repoRootDir!, storeDir!, cp);
  const lines = describe(d);
  if (lines.length === 0 && d.touched.length === 0) {
    vscode.window.showInformationMessage(`${folder} already matches the ${cp.command} checkpoint.`);
    return;
  }
  const shown = lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n… and ${lines.length - 20} more` : '');
  const ok = 'Revert';
  const choice = await vscode.window.showWarningMessage(
    `Revert ${folder} to before ${cp.command} (${new Date(cp.createdAt).toLocaleString()})?`,
    {
      modal: true,
      detail:
        `${d.modified.length} restored, ${d.removed.length} recreated, ${d.added.length} deleted` +
        (d.touched.length ? `, ${d.touched.length} timestamp(s) reset` : '') +
        '.\n\nOnly files inside this integration folder change; build output (bin/, obj/ …) is left alone. ' +
        'If Claude Code is still working on this folder, stop it first.\n\n' +
        shown,
    },
    ok,
  );
  if (choice !== ok) return;
  try {
    await revertCheckpoint(repoRootDir!, storeDir!, cp);
    countCache.delete(cp.id);
    onChanged?.();
    vscode.window.showInformationMessage(`Reverted ${folder} to before ${cp.command}. status.json was restored with it.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Revert failed part-way: ${(err as Error).message}. Compare with the checkpoint to see what is left.`);
  }
}

export async function showCheckpoints(folder: string): Promise<void> {
  const cp = await pickCheckpoint(folder);
  if (!cp) return;
  const action = await vscode.window.showQuickPick(['Compare with now', 'Revert to this checkpoint', 'Delete this checkpoint'], {
    title: `${cp.stageId}  ${cp.command} — ${new Date(cp.createdAt).toLocaleString()}`,
  });
  if (action === 'Compare with now') {
    const d = await diffCheckpoint(repoRootDir!, storeDir!, cp);
    const lines = describe(d);
    const pick = await vscode.window.showQuickPick(lines.length ? lines : ['No changes since this checkpoint'], { title: 'Changes since this checkpoint' });
    if (pick?.startsWith('restore ')) {
      const rel = pick.slice('restore  '.length);
      await vscode.commands.executeCommand('vscode.diff', await capturedUri(cp, rel), vscode.Uri.file(path.join(repoRootDir!, folder, rel)), `${rel} (checkpoint ↔ now)`);
    }
  } else if (action === 'Revert to this checkpoint') {
    // Revert this exact checkpoint, not the stage's latest.
    const d = await diffCheckpoint(repoRootDir!, storeDir!, cp);
    const ok = await vscode.window.showWarningMessage(
      `Revert ${folder} to this checkpoint? ${d.modified.length} restored, ${d.removed.length} recreated, ${d.added.length} deleted.`,
      { modal: true },
      'Revert',
    );
    if (ok === 'Revert') {
      await revertCheckpoint(repoRootDir!, storeDir!, cp);
      onChanged?.();
    }
  } else if (action === 'Delete this checkpoint') {
    await deleteCheckpoint(repoRootDir!, storeDir!, cp);
    await reindex();
  }
}
