// Build-time asset sync.
//
// Copies the pipeline's source-of-truth assets (the repo's `.claude/` agents,
// commands and skills, plus `schemas/`, `templates/`, `scripts/` and CLAUDE.md)
// into `tools/vscode-extension/assets/` so they ship inside the .vsix. The
// scaffolder (src/scaffold.ts) lays them into a new workspace; bundling keeps
// the launcher fully offline (matching the vendored IR visualizer).
//
// Run from npm: `node scripts/sync-assets.js`. Wired into `compile`, `watch`,
// and `vscode:prepublish` so the bundle is never hand-maintained — it always
// mirrors the live repo, so the two cannot drift.
//
// It also writes assets/manifest.json with the asset version, the git sha, and
// the `biztalkOnly` classification the scaffolder uses to drop BizTalk-only
// assets from a greenfield project.

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const extDir = path.resolve(__dirname, '..'); // tools/vscode-extension
const repoRoot = path.resolve(extDir, '..', '..'); // repo root
const outDir = path.join(extDir, 'assets');

/** Source → destination (both relative to repoRoot / outDir respectively). */
const COPY_SPEC = [
  ['.claude/agents', '.claude/agents'],
  ['.claude/commands', '.claude/commands'],
  ['.claude/skills', '.claude/skills'],
  ['schemas', 'schemas'],
  ['templates', 'templates'],
  ['scripts', 'scripts'],
  ['CLAUDE.md', 'CLAUDE.md'],
];

/** Recursively copy a file or directory. */
function copyRec(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRec(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/** All file paths under a directory, as POSIX paths relative to `base`. */
function walk(dir, base, acc) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) {
      walk(abs, base, acc);
    } else {
      acc.push(path.relative(base, abs).split(path.sep).join('/'));
    }
  }
  return acc;
}

/**
 * Classify the BizTalk-only assets the scaffolder skips for a greenfield
 * project. Entries are POSIX paths relative to the assets root; a directory
 * entry covers everything beneath it.
 */
function biztalkOnly() {
  const entries = new Set([
    '.claude/skills/biztalk-decompilation',
    '.claude/skills/biztalk-msi-extraction',
    '.claude/skills/biztalk-to-azure-mapping',
    'templates/biztalk',
    'scripts/crack-msi.ps1',
  ]);
  for (const sub of ['agents', 'commands']) {
    const dir = path.join(outDir, '.claude', sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('biztalk-')) entries.add(`.claude/${sub}/${name}`);
    }
  }
  return [...entries].sort();
}

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim();
  } catch {
    return undefined;
  }
}

function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let copied = 0;
  for (const [src, dst] of COPY_SPEC) {
    const from = path.join(repoRoot, src);
    if (!fs.existsSync(from)) {
      console.warn(`sync-assets: source missing, skipped: ${src}`);
      continue;
    }
    copyRec(from, path.join(outDir, dst));
  }
  // Count after copy so a missing source doesn't abort the count.
  copied = walk(outDir, outDir, []).length;

  const pkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf-8'));
  const manifest = {
    version: pkg.version,
    git: gitSha(),
    generatedAt: new Date().toISOString(),
    fileCount: copied,
    biztalkOnly: biztalkOnly(),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`sync-assets: ${copied} files → ${path.relative(extDir, outDir)} (v${manifest.version}${manifest.git ? ' @ ' + manifest.git : ''})`);
}

main();
