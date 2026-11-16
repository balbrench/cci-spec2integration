// Review gate (Change 3, Design A) against real temporary git repositories.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listCheckpoints } from '../src/checkpointCore.ts';
import {
  REVIEW_STAGE,
  approveFiles,
  baselineBytes,
  discardFiles,
  dropBaseline,
  ensureBaseline,
  getBaseline,
  isBookkeeping,
  pendingChanges,
  reviewedFolders,
} from '../src/reviewCore.ts';

const FOLDER = 'specs/payments/001-live';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2i-rv-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 's2i-rvstore-'));
  const f = path.join(root, FOLDER);
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(f, rel)), { recursive: true });
    fs.writeFileSync(path.join(f, rel), content);
  };
  const read = (rel: string) => fs.readFileSync(path.join(f, rel), 'utf-8');
  write('status.json', '{"lifecycle":"post-implementation"}\n');
  write('decisions.md', '# Decisions\n');
  write('app/wf/workflow.json', '{\r\n  "a": 1\r\n}\r\n'); // CRLF
  write('sql/proc.sql', 'select 1;\n');
  write('app/local.settings.json', '{"secret":"x"}\n'); // gitignored
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'true');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(root, '.gitignore'), 'local.settings.json\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  let t = Date.UTC(2026, 0, 1) / 1000;
  for (const rel of ['app/wf/workflow.json', 'sql/proc.sql', 'app/local.settings.json']) {
    fs.utimesSync(path.join(f, rel), t, t);
    t += 61.25;
  }
  return { root, store, f, write, read, cleanup: () => (fs.rmSync(root, { recursive: true, force: true }), fs.rmSync(store, { recursive: true, force: true })) };
}

test('isBookkeeping covers pipeline-written files only', () => {
  for (const p of ['status.json', 'decisions.md', 'implement-gates.json', 'review-report.md', 'review-report.json', 'reports/x-report.json']) {
    assert.equal(isBookkeeping(p), true, p);
  }
  for (const p of ['app/wf/workflow.json', 'sql/proc.sql', 'infra/main.bicep', 'mappings/report.md', 'app/status.json']) {
    assert.equal(isBookkeeping(p), false, p);
  }
});

test('a fresh baseline has nothing pending; bookkeeping edits never are', async () => {
  const r = makeRepo();
  try {
    const { created } = await ensureBaseline(r.root, r.store, FOLDER);
    assert.equal(created, true);
    assert.equal((await ensureBaseline(r.root, r.store, FOLDER)).created, false);
    assert.deepEqual(await pendingChanges(r.root, r.store, FOLDER), []);

    r.write('status.json', '{"lifecycle":"post-implementation","x":1}\n');
    r.write('decisions.md', '# Decisions\n\n## DD-01\n');
    r.write('implement-gates.json', '{}\n');
    r.write('review-report.md', 'PASS\n');
    assert.deepEqual(await pendingChanges(r.root, r.store, FOLDER), []);
  } finally {
    r.cleanup();
  }
});

test('edits, new files, deletions and shell-style writes are pending; line-ending-only changes are not', async () => {
  const r = makeRepo();
  try {
    await ensureBaseline(r.root, r.store, FOLDER);
    r.write('app/wf/workflow.json', '{\n  "a": 1\n}\n'); // CRLF → LF only
    r.write('sql/proc.sql', 'select 2;\n');
    r.write('infra/new.bicep', 'param x string\n');
    fs.rmSync(path.join(r.f, 'app/local.settings.json'));
    assert.deepEqual(await pendingChanges(r.root, r.store, FOLDER), [
      { path: 'app/local.settings.json', change: 'removed' },
      { path: 'infra/new.bicep', change: 'added' },
      { path: 'sql/proc.sql', change: 'modified' },
    ]);
  } finally {
    r.cleanup();
  }
});

test('approve keeps a file until it changes again; approving everything moves the baseline', async () => {
  const r = makeRepo();
  try {
    const first = (await ensureBaseline(r.root, r.store, FOLDER)).baseline;
    r.write('sql/proc.sql', 'select 2;\n');
    r.write('infra/new.bicep', 'param x string\n');

    await approveFiles(r.root, r.store, FOLDER, ['sql/proc.sql']);
    assert.deepEqual(await pendingChanges(r.root, r.store, FOLDER), [{ path: 'infra/new.bicep', change: 'added' }]);
    assert.equal((await getBaseline(r.store, FOLDER))!.id, first.id, 'baseline stays while anything is pending');

    r.write('sql/proc.sql', 'select 3;\n'); // edited again after approval
    assert.deepEqual((await pendingChanges(r.root, r.store, FOLDER)).map((p) => p.path), ['infra/new.bicep', 'sql/proc.sql']);

    await approveFiles(r.root, r.store, FOLDER, ['infra/new.bicep', 'sql/proc.sql']);
    assert.deepEqual(await pendingChanges(r.root, r.store, FOLDER), []);
    const moved = await getBaseline(r.store, FOLDER);
    assert.notEqual(moved!.id, first.id, 'baseline moved forward');
    assert.equal((await baselineBytes(r.root, r.store, FOLDER, 'sql/proc.sql'))!.toString(), 'select 3;\n');
    const all = await listCheckpoints(r.store, FOLDER);
    assert.deepEqual(all.map((c) => c.id), [moved!.id], 'old baseline deleted');
    assert.equal(all[0].stageId, REVIEW_STAGE);
    assert.equal(git(r.root, 'diff', '--cached', '--name-only'), '', 'nothing staged');
    assert.equal(git(r.root, 'rev-list', '--count', 'HEAD'), '1', 'HEAD untouched');
  } finally {
    r.cleanup();
  }
});

test('discard restores modified and deleted files byte- and mtime-exact, and deletes new ones', async () => {
  const r = makeRepo();
  try {
    await ensureBaseline(r.root, r.store, FOLDER);
    const before = fs.statSync(path.join(r.f, 'app/local.settings.json')).mtimeMs;
    const wfBefore = fs.readFileSync(path.join(r.f, 'app/wf/workflow.json'));
    r.write('app/wf/workflow.json', '{\n  "a": 2\n}\n');
    fs.rmSync(path.join(r.f, 'app/local.settings.json'));
    r.write('infra/deep/new.bicep', 'param x string\n');

    await discardFiles(r.root, r.store, FOLDER, ['app/wf/workflow.json', 'app/local.settings.json', 'infra/deep/new.bicep']);
    assert.deepEqual(await pendingChanges(r.root, r.store, FOLDER), []);
    assert.ok(fs.readFileSync(path.join(r.f, 'app/wf/workflow.json')).equals(wfBefore), 'CRLF bytes restored');
    assert.equal(r.read('app/local.settings.json'), '{"secret":"x"}\n');
    assert.ok(Math.abs(fs.statSync(path.join(r.f, 'app/local.settings.json')).mtimeMs - before) < 1);
    assert.equal(fs.existsSync(path.join(r.f, 'infra')), false, 'new file and its empty dirs removed');
  } finally {
    r.cleanup();
  }
});

test('dropBaseline forgets the folder and deletes its checkpoint', async () => {
  const r = makeRepo();
  try {
    await ensureBaseline(r.root, r.store, FOLDER);
    assert.deepEqual(await reviewedFolders(r.store), [FOLDER]);
    await dropBaseline(r.root, r.store, FOLDER);
    assert.deepEqual(await reviewedFolders(r.store), []);
    assert.deepEqual(await listCheckpoints(r.store, FOLDER), []);
    assert.equal(git(r.root, 'for-each-ref', 'refs/spec2integration'), '');
    assert.deepEqual(await pendingChanges(r.root, r.store, FOLDER), []);
  } finally {
    r.cleanup();
  }
});
