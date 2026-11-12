// Stage graph model — the data behind the stale-stage graph panel.
//
// Builds nodes from a status.json's stage rows (including sub-stages such as 1a,
// 3a, 5a–5e and 6a) and edges from the shared stage map, then assigns each node
// a column (longest path from a source) and a row. It computes nothing the
// pipeline doesn't already record: state, staleness and `next` all come from
// status.json.
//
// No `vscode` import: unit-tested in plain Node (`npm test`). Erasable syntax
// only, and `.ts` extensions on runtime imports, so Node can strip the types.

import type { IntegrationStatus } from './discovery';
import { pathsOverlap, stageEdges } from './stageMap.ts';
import type { StageMap } from './stageMap.ts';
import { findStageForCommand } from './commandCatalog.ts';

export type NodeState = 'done' | 'missing' | 'blocked' | 'stale' | 'other';

export interface GraphNode {
  id: string;
  name: string;
  /** Raw status from the stage row. */
  status: string;
  state: NodeState;
  summary?: string;
  frozen: boolean;
  isNext: boolean;
  /** Why the stage is stale, from status.json staleness[]. */
  staleReason?: string;
  /** The upstream path that made it stale. */
  stalerThan?: string;
  /** Command the panel's "Re-run" button sends; undefined when the stage can't be run from a row. */
  command?: string;
  /** Column, 0-based, left to right. */
  layer: number;
  /** Row within the column, 0-based, top to bottom. */
  row: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'data' | 'order';
  via?: string;
  /** True when this edge carries the upstream change that made `to` stale. */
  hot: boolean;
}

export interface StageGraphModel {
  folder: string;
  lifecycle: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: number;
  maxRows: number;
  next?: { command: string; reason?: string };
}

function stateOf(status: string): NodeState {
  switch (status) {
    case 'done':
    case 'covered':
      return 'done';
    case 'missing':
    case 'stale':
    case 'blocked':
      return status;
    default:
      return 'other';
  }
}

/**
 * @param commandFor stage id -> the command a row can run (commandCatalog.stageCommand).
 */
export function buildStageGraph(
  folder: string,
  status: IntegrationStatus,
  map: StageMap,
  commandFor: (stageId: string) => string | undefined,
): StageGraphModel {
  const stages = status.stages ?? [];
  const order = new Map(stages.map((s, i) => [s.id, i]));
  const staleness = new Map((status.staleness ?? []).map((e) => [e.stage, e]));
  const nextCmd = status.next?.command?.split(/\s+/)[0];
  const nextId = nextCmd ? findStageForCommand(nextCmd, stages) : undefined;

  // Edges between stages that are actually present in this status.json.
  const edges: GraphEdge[] = stageEdges(map)
    .filter((e) => order.has(e.from) && order.has(e.to))
    .map((e) => {
      const stale = staleness.get(e.to);
      const hot =
        e.kind === 'data' &&
        stages[order.get(e.to)!].status === 'stale' &&
        !!stale?.stalerThan &&
        !!e.via &&
        pathsOverlap(e.via, stale.stalerThan);
      return { from: e.from, to: e.to, kind: e.kind, via: e.via, hot };
    });

  // Column = longest path from a source. The map is a DAG; the guard stops a
  // malformed map from recursing forever.
  const preds = new Map<string, string[]>();
  for (const e of edges) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let l = 0;
    for (const p of preds.get(id) ?? []) l = Math.max(l, layerOf(p) + 1);
    visiting.delete(id);
    layer.set(id, l);
    return l;
  };

  // Rows: the first column keeps status.json order; each later column is sorted
  // by the average row of its predecessors (one barycentre pass), which keeps
  // most edges short and uncrossed. Ties keep status.json order.
  const byLayer: string[][] = [];
  for (const s of stages) (byLayer[layerOf(s.id)] ??= []).push(s.id);
  const rowOf = new Map<string, number>();
  byLayer.forEach((ids, l) => {
    const keyed = ids.map((id, i) => {
      const ps = l === 0 ? [] : (preds.get(id) ?? []).filter((p) => rowOf.has(p));
      const bary = ps.length ? ps.reduce((sum, p) => sum + rowOf.get(p)!, 0) / ps.length : i;
      return { id, bary, i };
    });
    keyed.sort((a, b) => a.bary - b.bary || a.i - b.i);
    keyed.forEach((k, row) => rowOf.set(k.id, row));
  });
  const rowsUsed = byLayer.map((ids) => ids.length);

  const nodes: GraphNode[] = stages.map((s) => {
    const l = layerOf(s.id);
    const row = rowOf.get(s.id)!;
    const stale = s.status === 'stale' ? staleness.get(s.id) : undefined;
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      state: stateOf(s.status),
      summary: s.summary,
      frozen: s.frozen === true,
      isNext: s.id === nextId,
      staleReason: stale ? stale.reason ?? `older than ${stale.stalerThan ?? 'an upstream source'}` : undefined,
      stalerThan: stale?.stalerThan,
      command: commandFor(s.id),
      layer: l,
      row,
    };
  });

  return {
    folder,
    lifecycle: status.lifecycle ?? 'generate',
    nodes,
    edges,
    layers: rowsUsed.length,
    maxRows: Math.max(0, ...rowsUsed),
    next: status.next ? { command: status.next.command, reason: status.next.reason } : undefined,
  };
}
