// Unit tests for src/stageGraphModel.ts against the real shared stage map.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { loadStageMap, stageCommandTable } from '../src/stageMap.ts';
import { NOT_ROW_RUNNABLE, setStageCommands, stageCommand } from '../src/commandCatalog.ts';
import { buildStageGraph } from '../src/stageGraphModel.ts';
import type { IntegrationStatus } from '../src/discovery.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const map = loadStageMap([repoRoot])!;
setStageCommands(stageCommandTable(map, 'azure', NOT_ROW_RUNNABLE));

const IDS = ['1', '1a', '2', '3', '3a', '4', '5', '5a', '5b', '5c', '5d', '5e', '6', '6a', '7', '8', '9', '10', '11', '12'];

function status(overrides: Partial<IntegrationStatus> = {}, statusById: Record<string, string> = {}): IntegrationStatus {
  return {
    folder: 'specs/x/001-demo',
    stages: IDS.map((id) => ({ id, name: `Stage ${id}`, status: statusById[id] ?? 'done' })),
    ...overrides,
  };
}

const node = (m: ReturnType<typeof buildStageGraph>, id: string) => m.nodes.find((n) => n.id === id)!;

test('every stage row becomes a node, in status.json order', () => {
  const m = buildStageGraph('f', status(), map, stageCommand);
  assert.deepEqual(m.nodes.map((n) => n.id), IDS);
  assert.equal(m.lifecycle, 'generate');
});

test('columns follow the longest dependency path', () => {
  const m = buildStageGraph('f', status(), map, stageCommand);
  assert.equal(node(m, '1').layer, 0);
  assert.equal(node(m, '2').layer, 1);
  assert.equal(node(m, '1a').layer, 1, 'clarify sits right after spec');
  assert.ok(node(m, '5').layer > node(m, '4').layer);
  assert.ok(node(m, '8').layer > node(m, '5').layer);
  assert.ok(node(m, '10').layer > node(m, '9').layer);
  assert.ok(node(m, '12').layer > node(m, '11').layer);
  // Every edge points rightwards.
  for (const e of m.edges) assert.ok(node(m, e.from).layer < node(m, e.to).layer, `${e.from}>${e.to}`);
  // Rows are unique within a column.
  const slots = m.nodes.map((n) => `${n.layer}:${n.row}`);
  assert.equal(new Set(slots).size, slots.length);
  assert.equal(m.layers, Math.max(...m.nodes.map((n) => n.layer)) + 1);
});

test('a spec.md edit marks the edges from stage 1 into stale stages as hot', () => {
  const m = buildStageGraph(
    'f',
    status(
      {
        staleness: [
          { stage: '2', stalerThan: 'spec.md', reason: 'spec.md edited after data-model.md' },
          { stage: '5', stalerThan: 'spec.md', reason: 'spec.md edited after integration-ir.yaml' },
        ],
        next: { command: '/model specs/x/001-demo' },
      },
      { '2': 'stale', '5': 'stale' },
    ),
    map,
    stageCommand,
  );
  const hot = m.edges.filter((e) => e.hot).map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(hot, ['1>2', '1>5']);
  assert.equal(node(m, '2').state, 'stale');
  assert.equal(node(m, '2').staleReason, 'spec.md edited after data-model.md');
  assert.equal(node(m, '2').isNext, true);
  assert.equal(node(m, '5').isNext, false);
  assert.equal(node(m, '5').command, '/architect');
});

test('a stale entry for a stage that is no longer stale is ignored', () => {
  const m = buildStageGraph('f', status({ staleness: [{ stage: '2', stalerThan: 'spec.md' }] }), map, stageCommand);
  assert.equal(node(m, '2').staleReason, undefined);
  assert.ok(!m.edges.some((e) => e.hot));
});

test('frozen stages and lifecycle come through; stages 1 and 7 have no row command', () => {
  const s = status({ lifecycle: 'post-implementation' });
  s.stages!.find((x) => x.id === '10')!.frozen = true;
  const m = buildStageGraph('f', s, map, stageCommand);
  assert.equal(m.lifecycle, 'post-implementation');
  assert.equal(node(m, '10').frozen, true);
  assert.equal(node(m, '9').frozen, false);
  assert.equal(node(m, '1').command, undefined);
  assert.equal(node(m, '7').command, undefined);
});

test('stages missing from status.json, and stages not in the map, are handled', () => {
  const m = buildStageGraph(
    'f',
    {
      folder: 'f',
      stages: [
        { id: '0a', name: 'Inventory', status: 'done' },
        { id: '1', name: 'Spec', status: 'done' },
        { id: '5', name: 'IR', status: 'missing' },
      ],
    },
    map,
    stageCommand,
  );
  assert.deepEqual(m.nodes.map((n) => n.id), ['0a', '1', '5']);
  assert.equal(node(m, '0a').layer, 0, 'unknown stage has no edges');
  assert.deepEqual(m.edges.map((e) => `${e.from}>${e.to}`), ['1>5'], 'only edges between present stages');
  assert.equal(node(m, '5').state, 'missing');
});
