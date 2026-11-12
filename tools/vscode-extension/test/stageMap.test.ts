// Unit tests for src/stageMap.ts. Run with `npm test` (Node's built-in runner;
// Node 22.18+ strips the TypeScript types natively).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadStageMap, parseStageMap, producerCommand, stageCommandTable, stageEdges } from '../src/stageMap.ts';
import { NOT_ROW_RUNNABLE } from '../src/commandCatalog.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

function realMap() {
  const map = loadStageMap([repoRoot]);
  assert.ok(map, 'schemas/stage-dependencies.json should load from the repo root');
  return map;
}

test('the repo map loads with unique ids in pipeline order', () => {
  const ids = realMap().stages.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, 3), ['1', '1a', '2']);
  assert.equal(ids[ids.length - 1], '12');
});

test('stage 10 artifacts cover Logic Apps, Function Apps and Data Factory', () => {
  const s10 = realMap().stages.find((s) => s.id === '10');
  assert.deepEqual(s10?.artifact, ['app', 'FunctionApps', 'adf']);
});

test('producerCommand fills in the platform', () => {
  const map = realMap();
  assert.equal(producerCommand(map, '10', 'azure'), '/implement-azure');
  assert.equal(producerCommand(map, '5', 'azure'), '/architect');
  assert.equal(producerCommand(map, 'nope', 'azure'), undefined);
});

test('the row command table matches the table the extension used to hard-code', () => {
  // The extension's STAGE_CMD table before it was derived from the map.
  const expected = {
    '1a': '/clarify', '2': '/model', '3': '/contracts', '3a': '/contracts', '4': '/map',
    '5': '/architect', '5a': '/review', '5b': '/review', '5c': '/review', '5d': '/review', '5e': '/review',
    '6': '/test-mappings', '6a': '/test-flows', '8': '/plan', '9': '/tasks',
    '10': '/implement-azure', '11': '/test-azure', '12': '/deploy-azure',
  };
  assert.deepEqual(stageCommandTable(realMap(), 'azure', NOT_ROW_RUNNABLE), expected);
});

test('ordering-only edges come from "after" and never duplicate a data edge', () => {
  const edges = stageEdges(realMap());
  const order = edges.filter((e) => e.kind === 'order').map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(order, ['10>12', '11>12', '1>1a', '7>8']);
  const pairs = edges.map((e) => `${e.from}>${e.to}`);
  assert.equal(new Set(pairs).size, pairs.length);
});

test('parseStageMap rejects an "after" that names an unknown stage', () => {
  assert.throws(() => parseStageMap('{"stages":[{"id":"2","after":["9"]}]}', 'x'), /unknown stage "9"/);
});

test('stageEdges links stages through shared paths', () => {
  const edges = stageEdges(realMap());
  const has = (from: string, to: string) => edges.some((e) => e.from === from && e.to === to);
  assert.ok(has('1', '2'), 'spec.md feeds the data model');
  assert.ok(has('3', '4'), 'contracts/ feeds mappings through a directory path');
  assert.ok(has('5', '8'), 'the IR feeds the plan');
  assert.ok(has('9', '10'), 'tasks feed implementation');
  assert.ok(!has('2', '1'), 'no backwards edge');
  // specs/PRD.md is repo-relative and has no producing stage.
  assert.ok(!edges.some((e) => e.to === '1'));
});

test('parseStageMap rejects malformed maps', () => {
  assert.throws(() => parseStageMap('{}', 'x'), /"stages" must be an array/);
  assert.throws(() => parseStageMap('{"stages":[{"id":"1"},{"id":"1"}]}', 'x'), /duplicate stage id/);
  assert.throws(() => parseStageMap('{"stages":[{"id":"1","artifact":"spec.md"}]}', 'x'), /array of strings/);
  assert.throws(() => parseStageMap('{"stages":[{}]}', 'x'), /has no "id"/);
});

test('loadStageMap falls back to the next root and skips invalid maps', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's2i-stagemap-'));
  try {
    const bad = path.join(tmp, 'bad');
    const good = path.join(tmp, 'good');
    fs.mkdirSync(path.join(bad, 'schemas'), { recursive: true });
    fs.mkdirSync(path.join(good, 'schemas'), { recursive: true });
    fs.writeFileSync(path.join(bad, 'schemas', 'stage-dependencies.json'), 'not json');
    fs.writeFileSync(path.join(good, 'schemas', 'stage-dependencies.json'), '{"stages":[{"id":"9","command":"/tasks"}]}');

    const map = loadStageMap([path.join(tmp, 'missing'), bad, good]);
    assert.equal(map?.source, path.join(good, 'schemas', 'stage-dependencies.json'));
    assert.equal(producerCommand(map!, '9', 'azure'), '/tasks');
    assert.equal(loadStageMap([path.join(tmp, 'missing')]), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
