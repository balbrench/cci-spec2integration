// Pipeline stage dependency map.
//
// Loads schemas/stage-dependencies.json — the single source of truth shared with
// scripts/refresh-status.ps1 — so the extension never hand-copies which command
// produces a stage or which upstream files make it stale.
//
// No `vscode` import: this module is unit-tested in plain Node (`npm test`).
// Keep it to erasable TypeScript syntax (no enums, namespaces or parameter
// properties) so Node's built-in type stripping can run it directly.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StageDep {
  id: string;
  /** Producing slash command; may contain `{platform}`. */
  command?: string;
  /** Artifact paths, relative to the integration folder. */
  artifact?: string[];
  /** Upstream paths, relative to the integration folder. */
  upstream?: string[];
  /** Upstream paths, relative to the repo root (e.g. specs/PRD.md). */
  repoUpstream?: string[];
  /** Skip the staleness check for reverse-engineered (BizTalk) integrations. */
  greenfieldOnly?: boolean;
  /** Ordering-only predecessors: no file dependency, never makes this stage stale. */
  after?: string[];
}

export interface StageMap {
  /** File the map was loaded from. */
  source: string;
  /** Stages in check order. */
  stages: StageDep[];
}

export interface StageEdge {
  /** Upstream stage id. */
  from: string;
  /** Downstream stage id. */
  to: string;
  /** The upstream path that links them (an artifact of `from`); undefined for an ordering edge. */
  via?: string;
  /** `data`: `to` reads a file `from` writes. `order`: `to` simply runs after `from`. */
  kind: 'data' | 'order';
}

export const MAP_RELATIVE_PATH = path.join('schemas', 'stage-dependencies.json');

/** Parse and validate the map's JSON text. Throws on a malformed map. */
export function parseStageMap(text: string, source: string): StageMap {
  const raw = JSON.parse(text) as { stages?: unknown };
  if (!Array.isArray(raw.stages)) {
    throw new Error(`${source}: "stages" must be an array`);
  }
  const seen = new Set<string>();
  const stages: StageDep[] = raw.stages.map((s: unknown, i: number) => {
    const e = s as Record<string, unknown>;
    if (typeof e?.id !== 'string' || !e.id) {
      throw new Error(`${source}: stages[${i}] has no "id"`);
    }
    if (seen.has(e.id)) {
      throw new Error(`${source}: duplicate stage id "${e.id}"`);
    }
    seen.add(e.id);
    for (const key of ['artifact', 'upstream', 'repoUpstream', 'after'] as const) {
      const v = e[key];
      if (v !== undefined && !(Array.isArray(v) && v.every((p) => typeof p === 'string'))) {
        throw new Error(`${source}: stages[${i}].${key} must be an array of strings`);
      }
    }
    if (e.command !== undefined && typeof e.command !== 'string') {
      throw new Error(`${source}: stages[${i}].command must be a string`);
    }
    return {
      id: e.id,
      command: e.command as string | undefined,
      artifact: e.artifact as string[] | undefined,
      upstream: e.upstream as string[] | undefined,
      repoUpstream: e.repoUpstream as string[] | undefined,
      greenfieldOnly: e.greenfieldOnly === true,
      after: e.after as string[] | undefined,
    };
  });
  for (const s of stages) {
    for (const a of s.after ?? []) {
      if (!seen.has(a)) throw new Error(`${source}: stage "${s.id}" is after unknown stage "${a}"`);
    }
  }
  return { source, stages };
}

/**
 * Load the map from the first root that has it: normally the workspace root
 * first, then the extension's bundled `assets/` folder. Returns undefined when
 * none has a readable, valid map.
 */
export function loadStageMap(roots: string[]): StageMap | undefined {
  for (const root of roots) {
    const file = path.join(root, MAP_RELATIVE_PATH);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    try {
      return parseStageMap(text, file);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The producing command for a stage, with `{platform}` filled in. */
export function producerCommand(map: StageMap, stageId: string, platform: string): string | undefined {
  const cmd = map.stages.find((s) => s.id === stageId)?.command;
  return cmd?.split('{platform}').join(platform);
}

/**
 * Stage id -> producing command for every stage that has one, with `{platform}`
 * filled in. `exclude` drops stages whose command the caller can't run with
 * just the folder argument.
 */
export function stageCommandTable(map: StageMap, platform: string, exclude: Iterable<string> = []): Record<string, string> {
  const skip = new Set(exclude);
  const table: Record<string, string> = {};
  for (const s of map.stages) {
    if (skip.has(s.id)) continue;
    const cmd = producerCommand(map, s.id, platform);
    if (cmd) table[s.id] = cmd;
  }
  return table;
}

/** True when `upstream` is `artifact` or lies beneath it, or the reverse. */
export function pathsOverlap(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

/**
 * Stage-to-stage edges: stage A feeds stage B when one of B's upstream paths
 * overlaps one of A's artifact paths (for example 5's `integration-ir.yaml`
 * feeds 8, and 3's `contracts/openapi.yaml` feeds 4 through `contracts`).
 * Repo-root upstreams (specs/PRD.md) have no producing stage and give no edge.
 * Each `after` entry adds an `order` edge unless a data edge already links the pair.
 */
export function stageEdges(map: StageMap): StageEdge[] {
  const edges: StageEdge[] = [];
  const linked = (from: string, to: string) => edges.some((e) => e.from === from && e.to === to);
  for (const to of map.stages) {
    for (const up of to.upstream ?? []) {
      for (const from of map.stages) {
        if (from.id === to.id) continue;
        if ((from.artifact ?? []).some((a) => pathsOverlap(a, up)) && !linked(from.id, to.id)) {
          edges.push({ from: from.id, to: to.id, via: up, kind: 'data' });
        }
      }
    }
  }
  for (const to of map.stages) {
    for (const from of to.after ?? []) {
      if (!linked(from, to.id)) edges.push({ from, to: to.id, kind: 'order' });
    }
  }
  return edges;
}
