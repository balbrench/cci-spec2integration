// Checkpoint/revert against real temporary git repositories. Revert is
// destructive, so these assert byte-for-byte and mtime-for-mtime equality.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  pruneCheckpoints,
  revertCheckpoint,
  walkFiles,
} from '../src/checkpointCore.ts';

const FOLDER = 'specs/payments/001-demo';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** A repo with an integration folder holding LF, CRLF, binary, ignored and build-output files. */
function makeRepo(opts: { gitRepo?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2i-cp-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 's2i-store-'));
  const f = path.join(root, FOLDER);
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(f, rel)), { recursive: true });
    fs.writeFileSync(path.join(f, rel), content);
  };
  write('spec.md', '# spec\nline two\n'); // LF
  write('integration-ir.yaml', 'flows:\r\n  - id: a\r\n'); // CRLF
  write('contracts/schemas/a.json', '{"a":1}\n');
  write('app/local.settings.json', '{"secret":"x"}\n'); // gitignored
  write('app/bin/Debug/out.dll', Buffer.from([0, 1, 2, 3])); // build output
  write('logo.bin', Buffer.from([0, 255, 13, 10, 10, 13]));
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside\n');
  if (opts.gitRepo !== false) {
    git(root, 'init', '-q');
    git(root, 'config', 'core.autocrlf', 'true'); // the line-ending conversion revert must survive
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(root, '.gitignore'), 'local.settings.json\nbin/\n');
    fs.writeFileSync(path.join(root, '.gitattributes'), '* text=auto\n*.bin binary\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  }
  // Distinct, old mtimes so a restore that loses them is caught.
  let t = Date.UTC(2026, 0, 1) / 1000;
  for (const rel of ['spec.md', 'integration-ir.yaml', 'contracts/schemas/a.json', 'app/local.settings.json', 'logo.bin']) {
    fs.utimesSync(path.join(f, rel), t, t);
    t += 61.25;
  }
  return { root, store, f, write, cleanup: () => (fs.rmSync(root, { recursive: true, force: true }), fs.rmSync(store, { recursive: true, force: true })) };
}

/** Every file under the folder (excluded dirs too) with bytes and mtime. */
function snapshot(dir: string) {
  const out: Record<string, { hex: string; mtime: number }> = {};
  const rec = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(path.join(abs, e.name), r);
      else out[r] = { hex: fs.readFileSync(path.join(abs, e.name)).toString('hex'), mtime: Math.round(fs.statSync(path.join(abs, e.name)).mtimeMs) };
    }
  };
  rec(dir, '');
  return out;
}

function simulateRun(r: ReturnType<typeof makeRepo>) {
  r.write('spec.md', '# spec\nrewritten by a bad run\n');
  r.write('integration-ir.yaml', 'flows: []\n'); // CRLF file rewritten as LF
  fs.rmSync(path.join(r.f, 'contracts/schemas/a.json'));
  r.write('app/local.settings.json', '{"secret":"changed"}\n');
  r.write('mappings/New.md', 'new\n');
  r.write('deep/new/dir/file.txt', 'new\n');
  r.write('app/bin/Debug/out.dll', Buffer.from([9, 9])); // build output: neither captured nor reverted
}

test('a run that adds, modifies and deletes files reverts byte- and mtime-identical', async () => {
  const r = makeRepo();
  try {
    const before = snapshot(r.f);
    const cp = await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '5', command: '/architect', storeDir: r.store });
    assert.ok(cp.commit && cp.ref?.startsWith('refs/spec2integration/checkpoints/specs/payments/001-demo/5/'));
    simulateRun(r);

    const d = await diffCheckpoint(r.root, r.store, cp);
    assert.deepEqual(d.added, ['deep/new/dir/file.txt', 'mappings/New.md']);
    assert.deepEqual(d.modified, ['app/local.settings.json', 'integration-ir.yaml', 'spec.md']);
    assert.deepEqual(d.removed, ['contracts/schemas/a.json']);

    await revertCheckpoint(r.root, r.store, cp);
    const after = snapshot(r.f);
    const expected = { ...before, 'app/bin/Debug/out.dll': after['app/bin/Debug/out.dll'] };
    assert.deepEqual(after, expected);
    assert.equal(fs.readFileSync(path.join(r.f, 'integration-ir.yaml'), 'utf-8'), 'flows:\r\n  - id: a\r\n', 'CRLF kept');
    assert.ok(!fs.existsSync(path.join(r.f, 'deep')), 'empty directories created by the run are removed');
    assert.deepEqual(Buffer.from(after['app/bin/Debug/out.dll'].hex, 'hex'), Buffer.from([9, 9]), 'build output left alone');

    const again = await diffCheckpoint(r.root, r.store, cp);
    assert.equal(again.added.length + again.modified.length + again.removed.length + again.touched.length, 0);
  } finally {
    r.cleanup();
  }
});

test('gitignored files are copied to storage, not into git objects', async () => {
  const r = makeRepo();
  try {
    const cp = await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '10', command: '/implement-azure', storeDir: r.store });
    const e = cp.entries.find((x) => x.path === 'app/local.settings.json');
    assert.equal(e?.source, 'copy');
    assert.equal(e?.sha, undefined);
    const tree = git(r.root, 'ls-tree', '-r', '--name-only', cp.commit!);
    assert.ok(!tree.includes('local.settings.json'));
    assert.ok(tree.includes(`${FOLDER}/spec.md`));
    assert.ok(!tree.includes('outside.txt'), 'only the integration folder is captured');
    assert.ok(!cp.entries.some((x) => x.path.includes('bin/')), 'build output is not captured');
  } finally {
    r.cleanup();
  }
});

test("the user's index, HEAD, stashes and files outside the folder are untouched", async () => {
  const r = makeRepo();
  try {
    r.write('spec.md', '# spec\nstaged edit\n');
    git(r.root, 'add', path.join(FOLDER, 'spec.md'));
    const head = git(r.root, 'rev-parse', 'HEAD');
    const staged = git(r.root, 'diff', '--cached');
    const status = git(r.root, 'status', '--porcelain');

    const cp = await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '5', command: '/architect', storeDir: r.store });
    assert.equal(git(r.root, 'diff', '--cached'), staged);
    assert.equal(git(r.root, 'status', '--porcelain'), status);

    simulateRun(r);
    fs.writeFileSync(path.join(r.root, 'outside.txt'), 'changed outside\n');
    await revertCheckpoint(r.root, r.store, cp);

    assert.equal(git(r.root, 'rev-parse', 'HEAD'), head);
    assert.equal(git(r.root, 'diff', '--cached'), staged);
    assert.equal(git(r.root, 'stash', 'list'), '');
    assert.equal(fs.readFileSync(path.join(r.root, 'outside.txt'), 'utf-8'), 'changed outside\n');
    assert.equal(fs.readFileSync(path.join(r.f, 'spec.md'), 'utf-8'), '# spec\nstaged edit\n');
  } finally {
    r.cleanup();
  }
});

test('outside a git repository every file is copied and the round trip still holds', async () => {
  const r = makeRepo({ gitRepo: false });
  try {
    const before = snapshot(r.f);
    const cp = await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '4', command: '/map', storeDir: r.store });
    assert.equal(cp.commit, undefined);
    assert.ok(cp.entries.every((e) => e.source === 'copy'));
    simulateRun(r);
    await revertCheckpoint(r.root, r.store, cp);
    const after = snapshot(r.f);
    assert.deepEqual(after, { ...before, 'app/bin/Debug/out.dll': after['app/bin/Debug/out.dll'] });
  } finally {
    r.cleanup();
  }
});

test('a touched-but-identical file only gets its mtime reset', async () => {
  const r = makeRepo();
  try {
    const cp = await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '1', command: '/specify', storeDir: r.store });
    const orig = fs.statSync(path.join(r.f, 'spec.md')).mtimeMs;
    fs.utimesSync(path.join(r.f, 'spec.md'), new Date(), new Date());
    const d = await diffCheckpoint(r.root, r.store, cp);
    assert.deepEqual(d.touched, ['spec.md']);
    assert.deepEqual(d.modified, []);
    await revertCheckpoint(r.root, r.store, cp);
    assert.ok(Math.abs(fs.statSync(path.join(r.f, 'spec.md')).mtimeMs - orig) < 1);
  } finally {
    r.cleanup();
  }
});

test('pruning keeps the newest N per folder and stage and deletes their refs', async () => {
  const r = makeRepo();
  try {
    let t = Date.UTC(2026, 5, 1);
    const now = () => new Date((t += 1000));
    for (let i = 0; i < 4; i++) await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '5', command: '/architect', storeDir: r.store, now });
    await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '8', command: '/plan', storeDir: r.store, now });
    assert.equal(await pruneCheckpoints(r.root, r.store, 2), 2);
    const left = await listCheckpoints(r.store, FOLDER);
    assert.deepEqual(left.map((c) => c.stageId), ['8', '5', '5']);
    const refs = git(r.root, 'for-each-ref', '--format=%(refname)', 'refs/spec2integration/').split('\n').filter(Boolean);
    assert.equal(refs.length, 3);
    assert.ok(left.every((c) => refs.includes(c.ref!)));
  } finally {
    r.cleanup();
  }
});

test('a run that deletes the whole folder is reverted from git and storage', async () => {
  const r = makeRepo();
  try {
    const before = snapshot(r.f);
    const cp = await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '5', command: '/architect', storeDir: r.store });
    fs.rmSync(r.f, { recursive: true, force: true });
    await revertCheckpoint(r.root, r.store, cp);
    const after = snapshot(r.f);
    const { ['app/bin/Debug/out.dll']: _bin, ...withoutBuild } = before;
    assert.deepEqual(after, withoutBuild, 'everything but build output comes back');
  } finally {
    r.cleanup();
  }
});

test('repeat checkpoints hard-link unchanged copies, and pruning the old one keeps the new one whole', async () => {
  const r = makeRepo({ gitRepo: false });
  try {
    let t = Date.UTC(2026, 5, 1);
    const now = () => new Date((t += 1000));
    await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '5', command: '/architect', storeDir: r.store, now });
    r.write('spec.md', '# spec\nchanged between checkpoints\n');
    const second = await createCheckpoint({ repoRoot: r.root, folder: FOLDER, stageId: '5', command: '/architect', storeDir: r.store, now });
    const stored = (rel: string) => path.join(r.store, 'checkpoints', second.id, 'files', rel);
    assert.ok(fs.statSync(stored('integration-ir.yaml')).nlink >= 2, 'unchanged file is shared');
    assert.equal(fs.statSync(stored('spec.md')).nlink, 1, 'changed file is a fresh copy');

    const before = snapshot(r.f);
    assert.equal(await pruneCheckpoints(r.root, r.store, 1), 1); // drops the first checkpoint
    simulateRun(r);
    await revertCheckpoint(r.root, r.store, second);
    const after = snapshot(r.f);
    assert.deepEqual(after, { ...before, 'app/bin/Debug/out.dll': after['app/bin/Debug/out.dll'] });
  } finally {
    r.cleanup();
  }
});

test('walkFiles skips excluded directories', async () => {
  const r = makeRepo({ gitRepo: false });
  try {
    const files = await walkFiles(r.f);
    assert.ok(files.includes('app/local.settings.json'));
    assert.ok(!files.some((p) => p.includes('/bin/')));
  } finally {
    r.cleanup();
  }
});
