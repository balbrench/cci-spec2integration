// Per-stage checkpoints for an integration folder (Phase 4, Change 2).
//
// A checkpoint is taken before the extension dispatches a stage command, and
// can be reverted with one click if the run went wrong.
//
// What is captured, byte for byte, with each file's modification time:
//   * files git would track (tracked, or untracked and not ignored): stored as
//     git blobs with --no-filters, so line-ending conversion never alters them,
//     committed on a private ref refs/spec2integration/checkpoints/<folder>/<stage>/<id>
//     built through a temporary index (the user's index, HEAD and stashes are
//     never touched);
//   * gitignored files (local.settings.json, appsettings.*.json …): copied into
//     the extension's storage, never into git objects, because they may hold
//     secrets;
//   * outside a git repository: every file is copied into storage.
// Build output (bin/, obj/, node_modules/, .azurite/, .vs/, TestResults/) is
// neither captured nor deleted.
//
// Revert writes the captured bytes back itself (not `git restore`, which would
// re-apply line-ending filters), deletes files created since, and restores
// every file's original mtime, so staleness after a revert matches the state
// before the run exactly.
//
// No `vscode` import: unit-tested in plain Node against temporary repos.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['bin', 'obj', 'node_modules', '.azurite', '.vs', 'TestResults', '.git']);
const REF_PREFIX = 'refs/spec2integration/checkpoints';
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Spec2Integration',
  GIT_AUTHOR_EMAIL: 'spec2integration@localhost',
  GIT_COMMITTER_NAME: 'Spec2Integration',
  GIT_COMMITTER_EMAIL: 'spec2integration@localhost',
};

export interface CheckpointEntry {
  /** Path relative to the integration folder, with forward slashes. */
  path: string;
  size: number;
  mtimeMs: number;
  /** `git`: a blob on the checkpoint commit. `copy`: a file in the checkpoint's storage folder. */
  source: 'git' | 'copy';
  sha?: string;
}

export interface Checkpoint {
  id: string;
  /** Repo-relative integration folder, forward slashes. */
  folder: string;
  stageId: string;
  command: string;
  createdAt: string;
  ref?: string;
  commit?: string;
  entries: CheckpointEntry[];
}

export interface CheckpointDiff {
  /** Exist now, not in the checkpoint: revert deletes them. */
  added: string[];
  /** Content differs: revert restores them. */
  modified: string[];
  /** In the checkpoint, missing now: revert recreates them. */
  removed: string[];
  /** Same content, different mtime: revert resets the mtime only. */
  touched: string[];
}

// ---------- helpers ----------

function run(cmd: string, args: string[], opts: { cwd: string; input?: string | Buffer; env?: NodeJS.ProcessEnv }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${Buffer.concat(err).toString().trim()}`));
    });
    child.stdin.end(opts.input ?? '');
  });
}

const git = (top: string, args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv) =>
  run('git', ['-c', 'core.quotepath=off', ...args], { cwd: top, input, env });

const toPosix = (p: string) => p.split(path.sep).join('/');

function safeRel(rel: string): string {
  const norm = path.posix.normalize(rel);
  if (norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm) || /^[A-Za-z]:/.test(norm)) {
    throw new Error(`unsafe checkpoint path: ${rel}`);
  }
  return norm;
}

/** Every regular file under `dir` (no symlinks, no excluded dirs), as dir-relative posix paths. */
export async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(abs: string, rel: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.has(e.name)) await rec(path.join(abs, e.name), r);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  }
  await rec(dir, '');
  return out.sort();
}

/** The git top-level containing `dir`, or undefined outside a repo or without git. */
async function gitTop(dir: string): Promise<string | undefined> {
  try {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).toString().trim();
    return top ? await fs.realpath(top) : undefined;
  } catch {
    return undefined;
  }
}

/** The repo holding a checkpoint's folder; falls back to the workspace root when the folder is gone. */
async function topFor(repoRoot: string, folder: string): Promise<string | undefined> {
  return (await gitTop(path.resolve(repoRoot, folder))) ?? (await gitTop(repoRoot));
}

/**
 * `dir` relative to the git top-level, with forward slashes, or undefined when
 * it is not inside one. Both sides go through realpath, so a Windows 8.3 short
 * path (C:\Users\ABCDEF~1\…) still compares equal to git's long form.
 */
async function relToTop(top: string | undefined, dir: string): Promise<string | undefined> {
  if (!top) return undefined;
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch {
    return undefined;
  }
  const rel = path.relative(top, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

function nulList(buf: Buffer): string[] {
  return buf.toString('utf-8').split('\0').filter(Boolean);
}

async function hashFiles(top: string, topRelPaths: string[], write: boolean): Promise<string[]> {
  if (topRelPaths.length === 0) return [];
  const args = ['hash-object', '--no-filters', ...(write ? ['-w'] : []), '--stdin-paths'];
  const out = (await git(top, args, topRelPaths.join('\n') + '\n')).toString().trim().split(/\r?\n/);
  if (out.length !== topRelPaths.length) throw new Error('git hash-object returned an unexpected number of hashes');
  return out;
}

function checkpointDir(storeDir: string, id: string): string {
  return path.join(storeDir, 'checkpoints', id);
}

// ---------- create ----------

export interface CreateOptions {
  repoRoot: string;
  /** Repo-relative integration folder. */
  folder: string;
  stageId: string;
  command: string;
  /** The extension's storage folder (context.storageUri). */
  storeDir: string;
  now?: () => Date;
}

export async function createCheckpoint(o: CreateOptions): Promise<Checkpoint> {
  const folder = toPosix(o.folder).replace(/\/+$/, '');
  const folderAbs = path.resolve(o.repoRoot, folder);
  const created = (o.now ?? (() => new Date()))();
  const id = `${created.getTime()}-${randomBytes(3).toString('hex')}`;
  const dir = checkpointDir(o.storeDir, id);
  const files = await walkFiles(folderAbs);

  // Which files git would track, relative to the git top-level.
  const top = await gitTop(folderAbs);
  const folderTop = await relToTop(top, folderAbs);
  let gitSet = new Set<string>();
  if (top && folderTop !== undefined) {
    const listed = nulList(await git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', folderTop || '.']));
    const prefix = folderTop ? folderTop + '/' : '';
    gitSet = new Set(listed.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)));
  }

  const entries: CheckpointEntry[] = [];
  const gitFiles = files.filter((f) => gitSet.has(f));
  const copyFiles = files.filter((f) => !gitSet.has(f));

  let commit: string | undefined;
  let ref: string | undefined;
  if (top && gitFiles.length > 0) {
    const prefix = folderTop ? folderTop + '/' : '';
    const shas = await hashFiles(top, gitFiles.map((f) => prefix + f), true);
    const index = path.join(os.tmpdir(), `s2i-index-${id}`);
    try {
      const env = { GIT_INDEX_FILE: index };
      const info = gitFiles.map((f, i) => `100644 ${shas[i]}\t${prefix}${f}\0`).join('');
      await git(top, ['update-index', '-z', '--add', '--index-info'], info, env);
      const tree = (await git(top, ['write-tree'], undefined, env)).toString().trim();
      commit = (
        await git(top, ['commit-tree', tree, '-m', `spec2integration checkpoint ${folder} stage ${o.stageId} (${o.command})`], undefined, IDENTITY)
      )
        .toString()
        .trim();
      ref = `${REF_PREFIX}/${folder}/${o.stageId}/${id}`;
      await git(top, ['update-ref', ref, commit]);
    } finally {
      await fs.rm(index, { force: true });
      await fs.rm(index + '.lock', { force: true });
    }
    for (let i = 0; i < gitFiles.length; i++) {
      const st = await fs.stat(path.join(folderAbs, gitFiles[i]));
      entries.push({ path: gitFiles[i], size: st.size, mtimeMs: st.mtimeMs, source: 'git', sha: shas[i] });
    }
  }

  // Copies: hard-link a file the folder's previous checkpoint already holds
  // unchanged (same size and mtime), so repeated checkpoints only store what
  // changed. Stored files are never modified, so sharing them is safe.
  const prev = (await listCheckpoints(o.storeDir, folder))[0];
  const prevCopies = new Map((prev?.entries ?? []).filter((e) => e.source === 'copy').map((e) => [e.path, e]));
  for (const f of copyFiles) {
    const src = path.join(folderAbs, f);
    const dst = path.join(dir, 'files', f);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    const st = await fs.stat(src);
    const p = prevCopies.get(f);
    let linked = false;
    if (p && p.size === st.size && Math.abs(p.mtimeMs - st.mtimeMs) < 1) {
      try {
        await fs.link(path.join(checkpointDir(o.storeDir, prev!.id), 'files', f), dst);
        linked = true;
      } catch {
        /* different volume, or the previous copy is gone: copy instead */
      }
    }
    if (!linked) await fs.copyFile(src, dst);
    entries.push({ path: f, size: st.size, mtimeMs: st.mtimeMs, source: 'copy' });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const cp: Checkpoint = { id, folder, stageId: o.stageId, command: o.command, createdAt: created.toISOString(), ref, commit, entries };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(cp, null, 2));
  return cp;
}

// ---------- list / read ----------

export async function listCheckpoints(storeDir: string, folder?: string): Promise<Checkpoint[]> {
  const root = path.join(storeDir, 'checkpoints');
  let ids: string[];
  try {
    ids = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: Checkpoint[] = [];
  for (const id of ids) {
    try {
      const cp = JSON.parse(await fs.readFile(path.join(root, id, 'manifest.json'), 'utf-8')) as Checkpoint;
      if (!folder || cp.folder === toPosix(folder).replace(/\/+$/, '')) out.push(cp);
    } catch {
      /* incomplete or foreign entry */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** The captured bytes of one entry. */
export async function readEntry(repoRoot: string, storeDir: string, cp: Checkpoint, entry: CheckpointEntry): Promise<Buffer> {
  if (entry.source === 'copy') return fs.readFile(path.join(checkpointDir(storeDir, cp.id), 'files', safeRel(entry.path)));
  const top = await topFor(repoRoot, cp.folder);
  if (!top || !entry.sha) throw new Error('the checkpoint was stored in git, but the folder is no longer in a git repository');
  return git(top, ['cat-file', 'blob', entry.sha]);
}

// ---------- diff ----------

export async function diffCheckpoint(repoRoot: string, storeDir: string, cp: Checkpoint): Promise<CheckpointDiff> {
  const folderAbs = path.resolve(repoRoot, cp.folder);
  const now = new Set(await walkFiles(folderAbs));
  const diff: CheckpointDiff = { added: [], modified: [], removed: [], touched: [] };
  const captured = new Set(cp.entries.map((e) => e.path));
  for (const f of now) if (!captured.has(f)) diff.added.push(f);

  const needHash: CheckpointEntry[] = [];
  for (const e of cp.entries) {
    if (!now.has(e.path)) {
      diff.removed.push(e.path);
      continue;
    }
    const st = await fs.stat(path.join(folderAbs, e.path));
    // mtimes round-trip through utimes with sub-millisecond loss, hence the tolerance.
    if (st.size === e.size && Math.abs(st.mtimeMs - e.mtimeMs) < 1) continue; // unchanged
    if (st.size !== e.size) {
      diff.modified.push(e.path);
    } else if (e.source === 'git') {
      needHash.push(e);
    } else {
      const same = (await fs.readFile(path.join(folderAbs, e.path))).equals(await readEntry(repoRoot, storeDir, cp, e));
      (same ? diff.touched : diff.modified).push(e.path);
    }
  }
  if (needHash.length) {
    const top = await topFor(repoRoot, cp.folder);
    const prefix = await relToTop(top, folderAbs);
    if (!top || prefix === undefined) throw new Error('the checkpoint was stored in git, but the folder is no longer in a git repository');
    const shas = await hashFiles(top, needHash.map((e) => (prefix ? `${prefix}/${e.path}` : e.path)), false);
    needHash.forEach((e, i) => (shas[i] === e.sha ? diff.touched : diff.modified).push(e.path));
  }
  for (const k of ['added', 'modified', 'removed', 'touched'] as const) diff[k].sort();
  return diff;
}

export const changedCount = (d: CheckpointDiff) => d.added.length + d.modified.length + d.removed.length;

// ---------- revert ----------

async function removeEmptyDirs(folderAbs: string, rel: string): Promise<void> {
  let dir = path.dirname(path.join(folderAbs, rel));
  while (dir.startsWith(folderAbs + path.sep)) {
    try {
      await fs.rmdir(dir); // only succeeds when empty
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** Put the folder back exactly as captured. Returns what was changed. */
export async function revertCheckpoint(repoRoot: string, storeDir: string, cp: Checkpoint): Promise<CheckpointDiff> {
  const folderAbs = path.resolve(repoRoot, cp.folder);
  const diff = await diffCheckpoint(repoRoot, storeDir, cp);
  const byPath = new Map(cp.entries.map((e) => [e.path, e]));

  for (const rel of diff.added) {
    await fs.rm(path.join(folderAbs, safeRel(rel)), { force: true });
    await removeEmptyDirs(folderAbs, rel);
  }
  for (const rel of [...diff.modified, ...diff.removed]) {
    const e = byPath.get(rel)!;
    const abs = path.join(folderAbs, safeRel(rel));
    const bytes = await readEntry(repoRoot, storeDir, cp, e);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  }
  for (const rel of [...diff.modified, ...diff.removed, ...diff.touched]) {
    const e = byPath.get(rel)!;
    const t = e.mtimeMs / 1000; // seconds as a number keeps the sub-millisecond part
    await fs.utimes(path.join(folderAbs, safeRel(rel)), t, t);
  }
  return diff;
}

// ---------- prune / delete ----------

export async function deleteCheckpoint(repoRoot: string, storeDir: string, cp: Checkpoint): Promise<void> {
  if (cp.ref) {
    const top = await topFor(repoRoot, cp.folder);
    if (top) await git(top, ['update-ref', '-d', cp.ref]).catch(() => undefined);
  }
  await fs.rm(checkpointDir(storeDir, cp.id), { recursive: true, force: true });
}

/** Keep the newest `keep` checkpoints per folder and stage; delete the rest. */
export async function pruneCheckpoints(repoRoot: string, storeDir: string, keep: number): Promise<number> {
  const all = await listCheckpoints(storeDir); // newest first
  const seen = new Map<string, number>();
  let removed = 0;
  for (const cp of all) {
    const key = `${cp.folder}\0${cp.stageId}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > Math.max(1, keep)) {
      await deleteCheckpoint(repoRoot, storeDir, cp);
      removed++;
    }
  }
  return removed;
}
