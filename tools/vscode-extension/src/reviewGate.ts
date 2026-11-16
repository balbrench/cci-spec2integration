// Review gate for edits to a live integration — the VS Code side of Phase 4,
// Change 3 (Design A). The baseline / approve / discard logic is in reviewCore.ts.
//
// For every integration the gate applies to (setting spec2integration.reviewGate:
// `frozen-only`, the default, means `status.json` lifecycle: post-implementation),
// the extension keeps a review baseline. File changes in that folder (from
// /change, a shell command, git, or another editor) are diffed against it;
// when new ones appear, a notification offers *Review*, and the integration row
// shows "N to review". The review lists each changed file: select it to see the
// diff, then Approve (keep) or Discard (restore) it, or Approve all.
//
// Design B (a PreToolUse pre-write gate) needs project hooks, which a managed
// allowManagedHooksOnly policy disables, so it is not built.

import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { discoverIntegrations, readStatus } from './discovery';
import { refreshTargetFor, ALL } from './statusRefreshCore';
import {
  PendingItem,
  approveFiles,
  baselineBytes,
  discardFiles,
  dropBaseline,
  ensureBaseline,
  pendingChanges,
  reviewedFolders,
} from './reviewCore';

type Mode = 'off' | 'frozen-only' | 'always';
const RECHECK_MS = 2000;

let storeDir: string | undefined;
let repoRootDir = '';
let onChanged: (() => void) | undefined;
/** Pending items per reviewed folder, as last computed. */
const pending = new Map<string, PendingItem[]>();
/** Paths already announced per folder, so a notification fires only for new ones. */
const announced = new Map<string, Set<string>>();
const timers = new Map<string, NodeJS.Timeout>();
/** Store mutations run one at a time. */
let queue: Promise<unknown> = Promise.resolve();
let output: vscode.OutputChannel | undefined;

function log(line: string): void {
  output ??= vscode.window.createOutputChannel('Spec2Integration');
  output.appendLine(`[${new Date().toISOString()}] review: ${line}`);
}

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

function mode(): Mode {
  return vscode.workspace.getConfiguration('spec2integration').get<Mode>('reviewGate', 'frozen-only');
}

/** For the tree: how many files in `folder` are waiting for review (0 when none or not reviewed). */
export function reviewPendingCount(folder: string): number {
  return pending.get(folder)?.length ?? 0;
}

export async function initReviewGate(context: vscode.ExtensionContext, repoRoot: string, changed: () => void): Promise<void> {
  if (!context.storageUri) return;
  storeDir = context.storageUri.fsPath;
  repoRootDir = repoRoot;
  onChanged = changed;
  await fs.mkdir(storeDir, { recursive: true });

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoRoot, 'specs/**'));
  const onFile = (uri: vscode.Uri) => {
    const target = refreshTargetFor(path.relative(repoRoot, uri.fsPath));
    if (target && target !== ALL && pending.has(target)) schedule(target);
  };
  watcher.onDidCreate(onFile);
  watcher.onDidChange(onFile);
  watcher.onDidDelete(onFile);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('spec2integration.reviewGate')) void syncReviewGate();
    }),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
  );

  // Folders reviewed in an earlier session: pick up edits made while VS Code was closed.
  for (const f of await reviewedFolders(storeDir)) pending.set(f, []);
  await syncReviewGate();
  for (const f of pending.keys()) await recheck(f);
}

function schedule(folder: string): void {
  clearTimeout(timers.get(folder));
  timers.set(folder, setTimeout(() => void recheck(folder), RECHECK_MS));
}

/**
 * Start or stop reviewing each integration to match the setting and its
 * lifecycle. Called on activation, on setting changes and whenever status.json
 * files change (a /lifecycle freeze or unfreeze).
 */
export function syncReviewGate(): Promise<void> {
  return serial(async () => {
    if (!storeDir) return;
    const m = mode();
    const wanted = new Set<string>();
    if (m !== 'off') {
      for (const f of await discoverIntegrations(repoRootDir)) {
        const st = await readStatus(repoRootDir, f);
        if (m === 'always' || st?.lifecycle === 'post-implementation') wanted.add(f);
      }
    }
    const started: string[] = [];
    for (const f of wanted) {
      const { created } = await ensureBaseline(repoRootDir, storeDir, f);
      if (!pending.has(f)) pending.set(f, []);
      if (created) {
        started.push(f);
        log(`baseline taken for ${f}`);
      }
    }
    for (const f of await reviewedFolders(storeDir)) {
      if (wanted.has(f)) continue;
      await dropBaseline(repoRootDir, storeDir, f);
      pending.delete(f);
      announced.delete(f);
      log(`stopped reviewing ${f}`);
    }
    if (started.length) {
      void vscode.window.showInformationMessage(
        `Spec2Integration will ask you to review changes to ${started.length === 1 ? started[0] : `${started.length} live integrations`} before they are kept. ` +
          'The current files are the approved baseline. (Setting: spec2integration.reviewGate.)',
      );
    }
    onChanged?.();
  }).catch((err) => log(`sync failed: ${(err as Error).message}`));
}

/** Recompute what is pending; announce new paths unless `quiet` (the review is already open). */
async function recheck(folder: string, quiet = false): Promise<void> {
  if (!storeDir || !pending.has(folder)) return;
  let items: PendingItem[];
  try {
    items = await serial(() => pendingChanges(repoRootDir, storeDir!, folder));
  } catch (err) {
    log(`could not diff ${folder}: ${(err as Error).message}`);
    return;
  }
  const before = pending.get(folder) ?? [];
  pending.set(folder, items);
  if (before.length !== items.length || before.some((b, i) => b.path !== items[i]?.path || b.change !== items[i]?.change)) onChanged?.();

  const seen = announced.get(folder) ?? new Set<string>();
  announced.set(folder, seen);
  const fresh = items.filter((i) => !seen.has(i.path));
  for (const i of items) seen.add(i.path);
  for (const p of [...seen]) if (!items.some((i) => i.path === p)) seen.delete(p);
  if (fresh.length === 0 || quiet) return;

  const review = 'Review';
  const all = 'Approve All';
  // Not awaited: callers must not wait for the user to answer.
  void vscode.window
    .showWarningMessage(
      `${items.length} change(s) to live integration ${folder} need review` +
        (fresh.length <= 3 ? `: ${fresh.map((i) => i.path).join(', ')}` : '') + '.',
      review,
      all,
    )
    .then((choice) => {
      if (choice === review) return reviewChanges(folder);
      if (choice === all) return approveAll(folder);
      return undefined;
    });
}

async function approveAll(folder: string): Promise<void> {
  const items = pending.get(folder) ?? [];
  await serial(() => approveFiles(repoRootDir, storeDir!, folder, items.map((i) => i.path)));
  await recheck(folder, true);
}

async function tempBaselineUri(folder: string, rel: string): Promise<vscode.Uri> {
  const bytes = (await baselineBytes(repoRootDir, storeDir!, folder, rel)) ?? Buffer.alloc(0);
  const file = path.join(os.tmpdir(), 'spec2integration-review', folder.replace(/[\\/]/g, '_'), rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return vscode.Uri.file(file);
}

async function showDiff(folder: string, item: PendingItem): Promise<void> {
  const current = vscode.Uri.file(path.join(repoRootDir, folder, item.path));
  if (item.change === 'modified') {
    await vscode.commands.executeCommand('vscode.diff', await tempBaselineUri(folder, item.path), current, `${item.path} (approved ↔ now)`, { preview: true, preserveFocus: true });
  } else if (item.change === 'added') {
    await vscode.window.showTextDocument(current, { preview: true, preserveFocus: true });
  } else {
    await vscode.window.showTextDocument(await tempBaselineUri(folder, item.path), { preview: true, preserveFocus: true });
  }
}

const LABEL: Record<PendingItem['change'], string> = { modified: 'changed', added: 'new file', removed: 'deleted' };
const ICON: Record<PendingItem['change'], string> = { modified: '$(diff)', added: '$(add)', removed: '$(trash)' };

/** The review: one row per pending file. Select to diff; row buttons approve or discard. */
export async function reviewChanges(folder: string): Promise<void> {
  if (!storeDir) return;
  if (!pending.has(folder)) {
    vscode.window.showInformationMessage(
      `${folder} is not under review. The review gate applies to deployed (frozen) integrations; see the spec2integration.reviewGate setting.`,
    );
    return;
  }
  await recheck(folder, true);
  if (reviewPendingCount(folder) === 0) {
    vscode.window.showInformationMessage(`Nothing to review in ${folder}: every file matches the approved baseline.`);
    return;
  }

  type Item = vscode.QuickPickItem & { item: PendingItem };
  const approveBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check'), tooltip: 'Approve (keep this change)' };
  const discardBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('discard'), tooltip: 'Discard (restore the approved version)' };
  const approveAllBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check-all'), tooltip: 'Approve all' };

  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `Review changes to live integration ${folder}`;
  qp.placeholder = 'Select a file to see its diff. ✓ approves, ↶ discards.';
  qp.ignoreFocusOut = true;
  qp.buttons = [approveAllBtn];
  const load = () => {
    qp.items = (pending.get(folder) ?? []).map((i) => ({
      label: `${ICON[i.change]} ${i.path}`,
      description: LABEL[i.change],
      buttons: [approveBtn, discardBtn],
      item: i,
    }));
    if (qp.items.length === 0) {
      qp.hide();
      vscode.window.showInformationMessage(`Review of ${folder} complete. The approved files are the new baseline.`);
    }
  };
  const act = async (fn: () => Promise<void>) => {
    qp.busy = true;
    try {
      await fn();
      await recheck(folder, true);
      load();
    } catch (err) {
      vscode.window.showErrorMessage(`Review action failed: ${(err as Error).message}`);
    } finally {
      qp.busy = false;
    }
  };

  qp.onDidAccept(() => {
    const sel = qp.activeItems[0];
    if (sel) void showDiff(folder, sel.item);
  });
  qp.onDidTriggerItemButton(async (e) => {
    const p = e.item.item;
    if (e.button === approveBtn) {
      await act(() => serial(() => approveFiles(repoRootDir, storeDir!, folder, [p.path])));
    } else {
      const what = p.change === 'added' ? `delete the new file ${p.path}` : p.change === 'removed' ? `recreate ${p.path}` : `restore the approved version of ${p.path}`;
      const ok = await vscode.window.showWarningMessage(`Discard this change and ${what}?`, { modal: true }, 'Discard');
      if (ok === 'Discard') await act(() => serial(() => discardFiles(repoRootDir, storeDir!, folder, [p.path])));
    }
  });
  qp.onDidTriggerButton(async (b) => {
    if (b === approveAllBtn) await act(() => serial(() => approveFiles(repoRootDir, storeDir!, folder, (pending.get(folder) ?? []).map((i) => i.path))));
  });
  qp.onDidHide(() => qp.dispose());
  load();
  qp.show();
}
