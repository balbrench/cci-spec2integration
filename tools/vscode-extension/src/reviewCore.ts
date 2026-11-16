// Review gate for edits to a live integration (Phase 4, Change 3, Design A).
//
// Once an integration is deployed (`status.json` lifecycle: post-implementation),
// its generated files are the source of truth, and `/change` edits them in
// place. This module keeps a *review baseline* per such folder: a checkpoint
// (checkpointCore.ts, stage id REVIEW_STAGE) of the folder as last approved.
// Every file that differs from the baseline is pending review until the user
// approves it (keep) or discards it (restore the baseline bytes and mtime).
// When nothing is pending any more, the baseline moves forward to the current
// folder, so the next edit starts a fresh review.
//
// Because this diffs the filesystem, it catches every write path: Claude Code
// tool edits, shell and script writes, git, and edits made while VS Code was
// closed (the baseline persists in the extension's storage).
//
// Not reviewed: files the pipeline rewrites on every refresh or every /change
// (status.json, decisions.md, reports, gate results), and changes that only
// convert line endings.
//
// No `vscode` import: unit-tested in plain Node.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  createCheckpoint,
  deleteCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  readEntry,
  removeEmptyDirs,
  safeRel,
} from './checkpointCore.ts';
import type { Checkpoint } from './checkpointCore.ts';

/** Stage id of review baselines; hidden from the checkpoint history UI. */
export const REVIEW_STAGE = '_review';
const DELETED = 'deleted';

const BOOKKEEPING_FILES = new Set([
  'status.json',
  'decisions.md',
  'implement-gates.json',
  'azure-review.md',
  'azure-review.json',
  'traceability-matrix.md',
]);

/** Files the pipeline itself rewrites: never part of a review. `rel` is folder-relative. */
export function isBookkeeping(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  if (BOOKKEEPING_FILES.has(p)) return true;
  return /(^|\/)[^/]*-report\.(md|json)$/.test(p);
}

export type ReviewChange = 'added' | 'modified' | 'removed';
export interface PendingItem {
  /** Folder-relative, forward slashes. */
  path: string;
  change: ReviewChange;
}

interface FolderState {
  baselineId: string;
  /** Approved paths → sha256 of the approved content, or `deleted`. */
  approved: Record<string, string>;
}
type ReviewState = Record<string, FolderState>;

const norm = (folder: string) => folder.replace(/\\/g, '/').replace(/\/+$/, '');
const statePath = (storeDir: string) => path.join(storeDir, 'review-state.json');

async function loadState(storeDir: string): Promise<ReviewState> {
  try {
    return JSON.parse(await fs.readFile(statePath(storeDir), 'utf-8')) as ReviewState;
  } catch {
    return {};
  }
}

async function saveState(storeDir: string, state: ReviewState): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true });
  const tmp = statePath(storeDir) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, statePath(storeDir));
}

async function currentHash(folderAbs: string, rel: string): Promise<string> {
  try {
    return createHash('sha256').update(await fs.readFile(path.join(folderAbs, safeRel(rel)))).digest('hex');
  } catch {
    return DELETED;
  }
}

/** Folders that currently have a review baseline. */
export async function reviewedFolders(storeDir: string): Promise<string[]> {
  return Object.keys(await loadState(storeDir));
}

/** The folder's baseline, or undefined when it has none (or its checkpoint is gone). */
export async function getBaseline(storeDir: string, folder: string): Promise<Checkpoint | undefined> {
  const st = (await loadState(storeDir))[norm(folder)];
  if (!st) return undefined;
  return (await listCheckpoints(storeDir, folder)).find((c) => c.id === st.baselineId);
}

/** Take a baseline of the folder as it is now, replacing any previous one. */
async function rebaseline(repoRoot: string, storeDir: string, folder: string): Promise<Checkpoint> {
  const f = norm(folder);
  const old = await getBaseline(storeDir, f);
  const cp = await createCheckpoint({ repoRoot, folder: f, stageId: REVIEW_STAGE, command: 'review baseline', storeDir });
  const state = await loadState(storeDir);
  state[f] = { baselineId: cp.id, approved: {} };
  await saveState(storeDir, state);
  if (old) await deleteCheckpoint(repoRoot, storeDir, old);
  return cp;
}

/** Make sure the folder has a baseline; the current contents become it when it has none. */
export async function ensureBaseline(repoRoot: string, storeDir: string, folder: string): Promise<{ baseline: Checkpoint; created: boolean }> {
  const existing = await getBaseline(storeDir, folder);
  if (existing) return { baseline: existing, created: false };
  return { baseline: await rebaseline(repoRoot, storeDir, folder), created: true };
}

/** Stop reviewing the folder (it was unfrozen, or the gate was turned off). */
export async function dropBaseline(repoRoot: string, storeDir: string, folder: string): Promise<void> {
  const f = norm(folder);
  const old = await getBaseline(storeDir, f);
  const state = await loadState(storeDir);
  if (state[f]) {
    delete state[f];
    await saveState(storeDir, state);
  }
  if (old) await deleteCheckpoint(repoRoot, storeDir, old);
}

const lf = (b: Buffer) => b.toString('latin1').replace(/\r\n/g, '\n');

/** Files that differ from the baseline and are not yet approved, sorted by path. */
export async function pendingChanges(repoRoot: string, storeDir: string, folder: string): Promise<PendingItem[]> {
  const f = norm(folder);
  const baseline = await getBaseline(storeDir, f);
  if (!baseline) return [];
  const approved = (await loadState(storeDir))[f]?.approved ?? {};
  const folderAbs = path.resolve(repoRoot, f);
  const d = await diffCheckpoint(repoRoot, storeDir, baseline);
  const byPath = new Map(baseline.entries.map((e) => [e.path, e]));

  const out: PendingItem[] = [];
  const consider: [string, ReviewChange][] = [
    ...d.added.map((p): [string, ReviewChange] => [p, 'added']),
    ...d.modified.map((p): [string, ReviewChange] => [p, 'modified']),
    ...d.removed.map((p): [string, ReviewChange] => [p, 'removed']),
  ];
  for (const [p, change] of consider) {
    if (isBookkeeping(p)) continue;
    if (approved[p] !== undefined && approved[p] === (await currentHash(folderAbs, p))) continue;
    if (change === 'modified') {
      // A change that only converts line endings is noise, not an edit.
      const now = await fs.readFile(path.join(folderAbs, safeRel(p)));
      const before = await readEntry(repoRoot, storeDir, baseline, byPath.get(p)!);
      if (lf(now) === lf(before)) continue;
    }
    out.push({ path: p, change });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Once nothing is pending, move the baseline forward to the folder as it is,
 * so approvals and bookkeeping churn are folded in. Returns whether it moved.
 */
async function settle(repoRoot: string, storeDir: string, folder: string): Promise<boolean> {
  if ((await pendingChanges(repoRoot, storeDir, folder)).length > 0) return false;
  const baseline = await getBaseline(storeDir, folder);
  if (!baseline) return false;
  const d = await diffCheckpoint(repoRoot, storeDir, baseline);
  if (d.added.length + d.modified.length + d.removed.length + d.touched.length === 0) return false;
  await rebaseline(repoRoot, storeDir, folder);
  return true;
}

/** Keep the files as they are now. A file edited again after approval is pending again. */
export async function approveFiles(repoRoot: string, storeDir: string, folder: string, paths: string[]): Promise<void> {
  const f = norm(folder);
  const state = await loadState(storeDir);
  const st = state[f];
  if (!st) return;
  const folderAbs = path.resolve(repoRoot, f);
  for (const p of paths) st.approved[p] = await currentHash(folderAbs, p);
  await saveState(storeDir, state);
  await settle(repoRoot, storeDir, f);
}

/** Put the files back as they are in the baseline: restore, recreate, or delete. */
export async function discardFiles(repoRoot: string, storeDir: string, folder: string, paths: string[]): Promise<void> {
  const f = norm(folder);
  const baseline = await getBaseline(storeDir, f);
  if (!baseline) return;
  const folderAbs = path.resolve(repoRoot, f);
  const byPath = new Map(baseline.entries.map((e) => [e.path, e]));
  for (const p of paths) {
    const abs = path.join(folderAbs, safeRel(p));
    const e = byPath.get(p);
    if (!e) {
      await fs.rm(abs, { force: true });
      await removeEmptyDirs(folderAbs, p);
      continue;
    }
    const bytes = await readEntry(repoRoot, storeDir, baseline, e);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
    const t = e.mtimeMs / 1000;
    await fs.utimes(abs, t, t);
  }
  const state = await loadState(storeDir);
  if (state[f]) {
    for (const p of paths) delete state[f].approved[p];
    await saveState(storeDir, state);
  }
  await settle(repoRoot, storeDir, f);
}

/** The baseline bytes of a file, for showing a diff. Undefined when the file is new. */
export async function baselineBytes(repoRoot: string, storeDir: string, folder: string, rel: string): Promise<Buffer | undefined> {
  const baseline = await getBaseline(storeDir, folder);
  const e = baseline?.entries.find((x) => x.path === rel);
  return baseline && e ? readEntry(repoRoot, storeDir, baseline, e) : undefined;
}
