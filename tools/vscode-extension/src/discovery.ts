// Discovery & status model.
//
// Reads the same files the web tools read — `specs/**/status.json` and
// `.spec2integration/state.json`. The folder-discovery logic is ported from
// tools/pipeline-runner/server.mjs (discoverIntegrations) so the two tools agree
// on what counts as an "integration".

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';

/** One row of the pipeline checklist, as written by the producing agent/command. */
export interface Stage {
  id: string;
  name: string;
  status: 'done' | 'missing' | 'blocked' | 'covered' | 'stale' | string;
  summary?: string;
}

export interface StalenessEntry {
  stage: string;
  stagename?: string;
  stalerThan?: string;
  reason?: string;
}

export interface NextStep {
  command: string;
  reason?: string;
}

/** Per-stage timing, keyed by stage id. `completedAt` is stamped when a stage
 *  first reaches `done`; `elapsedMs` is the gap to the previous completion. */
export interface StageTiming {
  completedAt?: string;
  elapsedMs?: number;
}

/** Coverage roll-up surfaced in the progress view. */
export interface Coverage {
  flowsTotal?: number;
  flowsWithTests?: number;
  mappingsTotal?: number;
  mappingsDocumented?: number;
}

/** The shape of a `<folder>/status.json`. Only the fields the extension reads. */
export interface IntegrationStatus {
  folder: string;
  generatedAt?: string;
  refreshedBy?: string;
  activePlatform?: string | null;
  stages?: Stage[];
  counts?: Record<string, number | null>;
  staleness?: StalenessEntry[];
  staleness_probed?: boolean;
  next?: NextStep | null;
  /** Richer e2e fields (optional; written by refresh-status.ps1 / agents). */
  coverage?: Coverage;
  blockedFlowIds?: string[];
  stageTiming?: Record<string, StageTiming>;
  /** Summary of the last implement run (artifact count, flow count, host). */
  lastImplement?: { completedAt?: string; flowCount?: number; host?: string; verdict?: string; artifactCount?: number };
}

/** The global `.spec2integration/state.json`. */
export interface PipelineState {
  activePlatform?: string | null;
  activeIntegration?: string | null;
  plugin?: string;
}

const isNnn = (name: string): boolean => /^\d{3}-/.test(name);

async function readJson<T>(absPath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(absPath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Read `.spec2integration/state.json` from the workspace root, if present. */
export async function readState(repoRoot: string): Promise<PipelineState> {
  const st = await readJson<PipelineState>(path.join(repoRoot, '.spec2integration', 'state.json'));
  return st ?? {};
}

/**
 * Discover every integration folder: `specs/NNN-slug` and `specs/<domain>/NNN-slug`,
 * each identified by the presence of a `status.json`. Returns repo-relative POSIX paths.
 * Ported from tools/pipeline-runner/server.mjs.
 */
export async function discoverIntegrations(repoRoot: string): Promise<string[]> {
  const specsRoot = path.join(repoRoot, 'specs');
  const found: string[] = [];
  let level1: import('node:fs').Dirent[];
  try {
    level1 = await fs.readdir(specsRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e1 of level1) {
    if (!e1.isDirectory()) continue;
    const p1 = path.join(specsRoot, e1.name);
    if (isNnn(e1.name) && existsSync(path.join(p1, 'status.json'))) {
      found.push(path.posix.join('specs', e1.name));
      continue;
    }
    let level2: import('node:fs').Dirent[] = [];
    try {
      level2 = await fs.readdir(p1, { withFileTypes: true });
    } catch {
      /* ignore */
    }
    for (const e2 of level2) {
      if (e2.isDirectory() && isNnn(e2.name) && existsSync(path.join(p1, e2.name, 'status.json'))) {
        found.push(path.posix.join('specs', e1.name, e2.name));
      }
    }
  }
  found.sort();
  return found;
}

/**
 * A BizTalk solution that has been inventoried/catalogued but has not yet
 * produced a numbered integration folder (`NNN-slug/status.json`).
 *
 * This is the legitimate pre-integration phase: `/biztalk-inventory` writes the
 * inventory + catalogue one level *above* the numbered folders (they are
 * solution-wide and decide how many integrations the solution becomes), so
 * `discoverIntegrations` — which keys off `NNN-/status.json` — would otherwise
 * show nothing until `/biztalk-reverse-engineer` mints the first `status.json`.
 */
export interface PreIntegration {
  /** The solution/domain folder, repo-relative POSIX (e.g. "specs/biztalk"). */
  folder: string;
  /** Folder-relative path to the inventory markdown, if present. */
  inventoryRel?: string;
  /** Folder-relative path to the catalogue markdown, if present. */
  catalogueRel?: string;
  /** Distinct INT-NNN boundaries parsed from the catalogue, if any. */
  boundaries?: number;
  /** Total artifacts summed from the inventory Summary table, if parseable. */
  artifacts?: number;
  /** Artifacts flagged manual-complexity, if parseable. */
  manual?: number;
}

const INVENTORY_FILE = 'biztalk-inventory.md';
const CATALOGUE_FILE = 'integration-catalogue.md';

/** One catalogue integration boundary (INT-NNN) and its migration state. */
export interface BiztalkGroup {
  /** Normalised id, e.g. "INT-002". */
  id: string;
  /** Catalogue Integration Name, e.g. "XmlMapping PaymentRegistration". */
  name: string;
  /** True once a numbered integration folder records this group as its source. */
  migrated: boolean;
  /** Repo-relative integration folder, when migrated. */
  integrationFolder?: string;
}

/** A BizTalk solution: the analysis artifacts plus per-group migration state. */
export interface BiztalkSolution {
  /** Domain folder name, e.g. "biztalk". */
  domain: string;
  /** Repo-relative POSIX folder, e.g. "specs/biztalk". */
  folder: string;
  inventoryRel?: string;
  catalogueRel?: string;
  /** Total artifacts summed from the inventory Summary table, if parseable. */
  artifacts?: number;
  /** Artifacts flagged manual-complexity, if parseable. */
  manual?: number;
  /** Catalogue groups (INT-NNN), each with its migration state. */
  groups: BiztalkGroup[];
  /** Numbered integration folders not tied to a catalogue group (e.g. a legacy
   *  whole-solution "combined" migration). Repo-relative. */
  ungroupedIntegrations: string[];
}

/** Sum the inventory Summary table's Count (col 2) and Manual (last col) cells.
 *  Tolerant of column drift: a row counts only when its Count cell is an integer. */
function parseInventoryCounts(inventory: string): { artifacts?: number; manual?: number } {
  let artifacts: number | undefined;
  let manual: number | undefined;
  for (const line of inventory.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    // "| Orchestrations (.odx) | 3 | 2 | 1 | 0 | 0 |" -> inner = [label,3,2,1,0,0]
    const inner = t.split('|').slice(1, -1).map((c) => c.trim());
    if (inner.length < 6) continue;
    const count = Number(inner[1]);
    if (!Number.isInteger(count)) continue; // header / separator / non-data row
    artifacts = (artifacts ?? 0) + count;
    const man = Number(inner[inner.length - 1]);
    if (Number.isInteger(man)) manual = (manual ?? 0) + man;
  }
  return { artifacts, manual };
}

/** Parse the `## Catalogue` table rows into {id,name}; falls back to `### INT-NNN: Name` headers. */
function parseCatalogueGroups(catalogue: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const line of catalogue.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const m = /^INT-(\d{1,4})$/i.exec(cells[0]);
    if (!m) continue;
    const id = `INT-${m[1].padStart(3, '0')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: cells[1] || id });
  }
  if (out.length === 0) {
    for (const m of catalogue.matchAll(/^#{2,4}\s+INT-(\d{1,4}):\s*(.+?)\s*$/gm)) {
      const id = `INT-${m[1].padStart(3, '0')}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: m[2].trim() });
    }
  }
  return out;
}

/** Extract the source group id (e.g. "INT-002") from a spec.md front matter, if any. */
function specSourceGroup(specText: string): string | undefined {
  const m = /Source group:\**\s*INT-(\d{1,4})\b/i.exec(specText);
  return m ? `INT-${m[1].padStart(3, '0')}` : undefined;
}

/** Map each numbered integration folder under a domain to its source group (if any). */
async function mapGroupsToFolders(
  domain: string,
  domainAbs: string,
): Promise<{ byGroup: Map<string, string>; ungrouped: string[] }> {
  const byGroup = new Map<string, string>();
  const ungrouped: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(domainAbs, { withFileTypes: true });
  } catch {
    return { byGroup, ungrouped };
  }
  for (const e of entries) {
    if (!e.isDirectory() || !isNnn(e.name)) continue;
    if (!existsSync(path.join(domainAbs, e.name, 'status.json'))) continue;
    const folder = path.posix.join('specs', domain, e.name);
    let group: string | undefined;
    try {
      group = specSourceGroup(await fs.readFile(path.join(domainAbs, e.name, 'spec.md'), 'utf-8'));
    } catch {
      group = undefined;
    }
    if (group) byGroup.set(group, folder);
    else ungrouped.push(folder);
  }
  return { byGroup, ungrouped };
}

/**
 * Discover BizTalk solutions: a domain folder under `specs/` that has an
 * inventory or catalogue file, plus the per-group migration state derived from
 * the catalogue and each numbered folder's `spec.md` Source-group line.
 */
export async function discoverBiztalkSolutions(repoRoot: string): Promise<BiztalkSolution[]> {
  const specsRoot = path.join(repoRoot, 'specs');
  const out: BiztalkSolution[] = [];
  let level1: import('node:fs').Dirent[];
  try {
    level1 = await fs.readdir(specsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e1 of level1) {
    if (!e1.isDirectory() || isNnn(e1.name)) continue;
    const domainAbs = path.join(specsRoot, e1.name);
    const invAbs = path.join(domainAbs, INVENTORY_FILE);
    const catAbs = path.join(domainAbs, CATALOGUE_FILE);
    const hasInv = existsSync(invAbs);
    const hasCat = existsSync(catAbs);
    if (!hasInv && !hasCat) continue; // not a BizTalk solution

    let catalogueText = '';
    if (hasCat) {
      try {
        catalogueText = await fs.readFile(catAbs, 'utf-8');
      } catch {
        /* ignore */
      }
    }
    const { byGroup, ungrouped } = await mapGroupsToFolders(e1.name, domainAbs);
    const sol: BiztalkSolution = {
      domain: e1.name,
      folder: path.posix.join('specs', e1.name),
      inventoryRel: hasInv ? INVENTORY_FILE : undefined,
      catalogueRel: hasCat ? CATALOGUE_FILE : undefined,
      groups: parseCatalogueGroups(catalogueText).map((g) => ({
        id: g.id,
        name: g.name,
        migrated: byGroup.has(g.id),
        integrationFolder: byGroup.get(g.id),
      })),
      ungroupedIntegrations: ungrouped,
    };
    if (hasInv) {
      try {
        const c = parseInventoryCounts(await fs.readFile(invAbs, 'utf-8'));
        sol.artifacts = c.artifacts;
        sol.manual = c.manual;
      } catch {
        /* ignore */
      }
    }
    out.push(sol);
  }
  out.sort((a, b) => a.folder.localeCompare(b.folder));
  return out;
}

/**
 * Pre-integration view for the progress webview: one entry per BizTalk solution
 * that still has work to surface (an unmigrated group, or no integration yet).
 * Derived from {@link discoverBiztalkSolutions}.
 */
export async function discoverPreIntegrations(repoRoot: string): Promise<PreIntegration[]> {
  const sols = await discoverBiztalkSolutions(repoRoot);
  const out: PreIntegration[] = [];
  for (const s of sols) {
    const pending =
      s.groups.length === 0
        ? s.ungroupedIntegrations.length === 0 // no groups parsed & nothing migrated
        : s.groups.some((g) => !g.migrated);
    if (!pending) continue;
    out.push({
      folder: s.folder,
      inventoryRel: s.inventoryRel,
      catalogueRel: s.catalogueRel,
      boundaries: s.groups.length || undefined,
      artifacts: s.artifacts,
      manual: s.manual,
    });
  }
  return out;
}

/** Read a single integration's status.json (repo-relative folder path). */
export async function readStatus(
  repoRoot: string,
  folder: string,
): Promise<IntegrationStatus | null> {
  const st = await readJson<IntegrationStatus>(path.join(repoRoot, folder, 'status.json'));
  if (!st) return null;
  if (!st.folder) st.folder = folder;
  return st;
}
