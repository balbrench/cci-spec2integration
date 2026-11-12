import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL, RefreshScheduler, refreshTargetFor } from '../src/statusRefreshCore.ts';

test('changes inside an integration folder map to that folder', () => {
  assert.equal(refreshTargetFor('specs/payments/001-auth/spec.md'), 'specs/payments/001-auth');
  assert.equal(refreshTargetFor('specs\\payments\\001-auth\\app\\Flow\\workflow.json'), 'specs/payments/001-auth');
  assert.equal(refreshTargetFor('specs/001-flat/integration-ir.yaml'), 'specs/001-flat');
  assert.equal(refreshTargetFor('./specs/d/002-x/contracts/openapi.yaml'), 'specs/d/002-x');
});

test('shared inputs refresh every integration', () => {
  assert.equal(refreshTargetFor('specs/PRD.md'), ALL);
  assert.equal(refreshTargetFor('.spec2integration/state.json'), ALL);
  assert.equal(refreshTargetFor('specs/biztalk/biztalk-inventory.md'), ALL);
});

test('status.json, build output and files outside integrations are ignored', () => {
  assert.equal(refreshTargetFor('specs/payments/001-auth/status.json'), undefined);
  assert.equal(refreshTargetFor('specs/payments/001-auth/tests-mstest/A.Tests/bin/Debug/x.dll'), undefined);
  assert.equal(refreshTargetFor('specs/payments/001-auth/FunctionApps/F/obj/project.assets.json'), undefined);
  assert.equal(refreshTargetFor('specs/payments/001-auth/app/.azurite/__blobstorage__/x'), undefined);
  assert.equal(refreshTargetFor('specs/payments/notes.md'), undefined);
  assert.equal(refreshTargetFor('docs/readme.md'), undefined);
  assert.equal(refreshTargetFor('.spec2integration/hook.log'), undefined);
  assert.equal(refreshTargetFor(''), undefined);
});

/** A fake clock driving the scheduler's timers by hand. */
function fakeTimers() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    async advance(ms: number) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > now) break;
        timers.shift();
        t.fn();
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

test('a burst of changes runs once after the quiet period', async () => {
  const clock = fakeTimers();
  const runs: string[] = [];
  const s = new RefreshScheduler({ delayMs: 100, run: async (t) => void runs.push(t), ...clock });
  s.touch('a');
  await clock.advance(50);
  s.touch('a');
  await clock.advance(50);
  s.touch('a');
  assert.deepEqual(runs, []);
  await clock.advance(100);
  assert.deepEqual(runs, ['a']);
  assert.equal(s.busy, false);
});

test('folders debounce independently', async () => {
  const clock = fakeTimers();
  const runs: string[] = [];
  const s = new RefreshScheduler({ delayMs: 100, run: async (t) => void runs.push(t), ...clock });
  s.touch('a');
  s.touch('b');
  await clock.advance(100);
  assert.deepEqual(runs.sort(), ['a', 'b']);
});

test('changes during a run give exactly one follow-up run, never an overlap', async () => {
  const clock = fakeTimers();
  const runs: string[] = [];
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const s = new RefreshScheduler({
    delayMs: 100,
    run: async (t) => {
      active++;
      maxActive = Math.max(maxActive, active);
      runs.push(t);
      if (runs.length === 1) await new Promise<void>((r) => (release = r));
      active--;
    },
    ...clock,
  });
  s.touch('a');
  await clock.advance(100); // first run starts and blocks
  s.touch('a');
  s.touch('a');
  s.touch('a');
  release();
  await new Promise((r) => setImmediate(r));
  await clock.advance(100);
  assert.deepEqual(runs, ['a', 'a']);
  assert.equal(maxActive, 1);
});

test('an ALL refresh swallows pending folder refreshes', async () => {
  const clock = fakeTimers();
  const runs: string[] = [];
  const s = new RefreshScheduler({ delayMs: 100, run: async (t) => void runs.push(t), ...clock });
  s.touch('a');
  s.touch(ALL);
  s.touch('b'); // covered by the pending ALL
  await clock.advance(100);
  assert.deepEqual(runs, [ALL]);
});

test('a failing run does not stop later runs, and dispose cancels pending ones', async () => {
  const clock = fakeTimers();
  const runs: string[] = [];
  const s = new RefreshScheduler({
    delayMs: 10,
    run: async (t) => {
      runs.push(t);
      throw new Error('script failed');
    },
    ...clock,
  });
  s.touch('a');
  await clock.advance(10);
  s.touch('a');
  await clock.advance(10);
  assert.deepEqual(runs, ['a', 'a']);
  s.touch('b');
  s.dispose();
  await clock.advance(10);
  assert.deepEqual(runs, ['a', 'a']);
});
