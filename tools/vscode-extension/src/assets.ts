// Bundled pipeline assets — read the manifest, copy them (mode-filtered) into a
// new workspace, and optionally refresh them from GitHub.
//
// The assets (`.claude/` agents/commands/skills, `schemas/`, `templates/`,
// `scripts/`, CLAUDE.md) are synced into `<ext>/assets/` at build time by
// scripts/sync-assets.js, so scaffolding is fully offline. The GitHub update is
// the only networked path (the "hybrid" half: bundle a pinned snapshot, refresh
// on demand).

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import { promises as fs } from 'node:fs';

export type Mode = 'greenfield' | 'biztalk';

export interface AssetManifest {
  version: string;
  git?: string;
  generatedAt?: string;
  fileCount?: number;
  /** POSIX paths (file or directory prefix) relative to the assets root that a
   *  greenfield project omits. */
  biztalkOnly: string[];
}

/** Absolute path of the bundled assets root inside the extension. */
export function assetsDir(context: vscode.ExtensionContext): string {
  return path.join(context.extensionUri.fsPath, 'assets');
}

export async function readManifest(context: vscode.ExtensionContext): Promise<AssetManifest | null> {
  try {
    const raw = await fs.readFile(path.join(assetsDir(context), 'manifest.json'), 'utf-8');
    return JSON.parse(raw) as AssetManifest;
  } catch {
    return null;
  }
}

/** True when `relPosix` is the BizTalk-only path itself or sits beneath one. */
function isBiztalkOnly(relPosix: string, manifest: AssetManifest | null): boolean {
  if (!manifest) return relPosix.includes('biztalk');
  return manifest.biztalkOnly.some((b) => relPosix === b || relPosix.startsWith(b + '/'));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list files under `dir` as POSIX paths relative to `base`. */
async function walk(dir: string, base: string, acc: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, base, acc);
    else acc.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return acc;
}

/**
 * Copy the bundled assets into `targetDir`, skipping BizTalk-only assets for a
 * greenfield project and the manifest itself. Returns the number of files
 * copied.
 */
export async function copyAssets(
  context: vscode.ExtensionContext,
  mode: Mode,
  targetDir: string,
): Promise<number> {
  const root = assetsDir(context);
  if (!(await exists(root))) {
    throw new Error('Bundled assets are missing (assets/). Run `npm run sync-assets` before packaging.');
  }
  const manifest = await readManifest(context);
  const files = await walk(root, root);
  let copied = 0;
  for (const rel of files) {
    if (rel === 'manifest.json') continue;
    if (mode === 'greenfield' && isBiztalkOnly(rel, manifest)) continue;
    const dst = path.join(targetDir, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(path.join(root, rel), dst);
    copied++;
  }
  return copied;
}

// ---------- GitHub update (hybrid refresh) ----------

const GH_OWNER = 'balbrench';
const GH_REPO = 'cci-spec2integration';
const GH_BRANCH = 'main';

/** GET a URL into a Buffer, following redirects (codeload issues a 302). */
function httpsGet(url: string, redirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'spec2integration-vscode' } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          if (redirects <= 0) return reject(new Error('too many redirects'));
          res.resume();
          return resolve(httpsGet(res.headers.location, redirects - 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${status} for ${url}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

/** Minimal POSIX/ustar tar extractor — no external dependency. Extracts only the
 *  entries whose path (after the leading `<repo>-<branch>/` prefix) is one we
 *  manage, writing them under `destRoot`. */
async function extractTar(tar: Buffer, destRoot: string): Promise<number> {
  const KEEP = /^(\.claude\/(agents|commands|skills)\/|schemas\/|templates\/|scripts\/|CLAUDE\.md$)/;
  let offset = 0;
  let written = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf-8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr || '0', 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    // Strip the GitHub tarball's top-level `<repo>-<branch>/` directory.
    const rel = name.replace(/^[^/]+\//, '');
    if ((typeflag === '0' || typeflag === '\0') && rel && KEEP.test(rel)) {
      const dst = path.join(destRoot, rel);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.writeFile(dst, tar.subarray(dataStart, dataStart + size));
      written++;
    }
    // Advance past the data, padded up to the next 512-byte boundary.
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return written;
}

/**
 * Refresh the current workspace's pipeline assets from GitHub. Downloads the
 * repo tarball, extracts the managed subset into a temp dir, then overlays it
 * onto the workspace — so a failed download never leaves a half-written tree.
 */
export async function updateAssetsFromGitHub(repoRoot: string): Promise<{ written: number; ref: string }> {
  const ref = `refs/heads/${GH_BRANCH}`;
  const url = `https://codeload.github.com/${GH_OWNER}/${GH_REPO}/tar.gz/${ref}`;
  const gz = await httpsGet(url);
  const tar = zlib.gunzipSync(gz);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's2i-assets-'));
  try {
    const written = await extractTar(tar, tmp);
    if (written === 0) throw new Error('archive contained no recognised pipeline assets');
    // Overlay temp → workspace.
    for (const rel of await walk(tmp, tmp)) {
      const dst = path.join(repoRoot, rel);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(path.join(tmp, rel), dst);
    }
    await fs.mkdir(path.join(repoRoot, '.spec2integration'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.spec2integration', 'assets-version.json'),
      JSON.stringify({ source: 'github', ref: GH_BRANCH, updatedAt: new Date().toISOString(), fileCount: written }, null, 2) + '\n',
    );
    return { written, ref: GH_BRANCH };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
