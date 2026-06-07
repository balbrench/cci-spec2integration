// Stage-completion & Sev-1 notifications.
//
// Driven off the same status.json watcher that refreshes the tree. We keep a
// per-folder snapshot and toast only on a *transition*: a stage flipping to
// `done`, or the Sev-1 count rising / a review going blocked. The first read of
// a folder primes the snapshot silently so opening a populated workspace never
// triggers a toast storm.

import * as vscode from 'vscode';
import { discoverIntegrations, readStatus, IntegrationStatus } from './discovery';

interface Snapshot {
  stageStatus: Record<string, string>;
  sev1: number;
  primed: boolean;
}

const snapshots = new Map<string, Snapshot>();

function num(v: number | null | undefined): number {
  return typeof v === 'number' ? v : 0;
}

function snapshotOf(status: IntegrationStatus | null): Snapshot {
  const stageStatus: Record<string, string> = {};
  for (const s of status?.stages ?? []) stageStatus[s.id] = s.status;
  return { stageStatus, sev1: num(status?.counts?.sev1), primed: true };
}

function slug(folder: string): string {
  return folder.split('/').pop() ?? folder;
}

/** Re-read every integration and toast on meaningful transitions since last read. */
export async function checkNotifications(repoRoot: string): Promise<void> {
  const folders = await discoverIntegrations(repoRoot);
  for (const folder of folders) {
    const status = await readStatus(repoRoot, folder);
    const next = snapshotOf(status);
    const prev = snapshots.get(folder);
    snapshots.set(folder, next);
    if (!prev || !prev.primed) continue; // first sighting — prime silently

    // Stage completions.
    const newlyDone = (status?.stages ?? []).filter(
      (s) => s.status === 'done' && prev.stageStatus[s.id] && prev.stageStatus[s.id] !== 'done',
    );
    for (const s of newlyDone) {
      void vscode.window.showInformationMessage(`${slug(folder)}: ${s.id} ${s.name} complete${s.summary ? ` — ${s.summary}` : ''}`);
    }

    // New Sev-1 findings.
    if (next.sev1 > prev.sev1) {
      const open = 'Open Visualizer';
      void vscode.window
        .showWarningMessage(`${slug(folder)}: ${next.sev1} Sev-1 finding${next.sev1 === 1 ? '' : 's'} — pipeline is blocked.`, open)
        .then((choice) => {
          if (choice === open) void vscode.commands.executeCommand('spec2integration.openVisualizer', { folder });
        });
    }
  }
}

/** Drop a folder's snapshot (e.g. on delete) so it re-primes cleanly. */
export function resetNotifications(): void {
  snapshots.clear();
}
