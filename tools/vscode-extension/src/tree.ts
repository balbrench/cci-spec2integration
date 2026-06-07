// Sidebar tree: integrations (level 1) -> pipeline stages (level 2).
// Fed entirely by `<folder>/status.json` and `.spec2integration/state.json`.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  discoverIntegrations,
  discoverBiztalkSolutions,
  readState,
  readStatus,
  IntegrationStatus,
  BiztalkSolution,
  BiztalkGroup,
  Stage,
  StalenessEntry,
} from './discovery';
import { STAGE_CMD } from './commandCatalog';
import { resolveArtifact, resolveReport } from './artifacts';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

type Counts = Record<string, number | null | undefined>;

/** A non-null, present count (treats null / undefined / missing as absent). */
function n(counts: Counts | undefined, key: string): number | undefined {
  const v = counts?.[key];
  return typeof v === 'number' ? v : undefined;
}

/** Compact one-line findings badge for an integration row description (only issues). */
function findingsBadge(status: IntegrationStatus | null): string {
  const c = status?.counts;
  const parts: string[] = [];
  const sev1 = n(c, 'sev1');
  const sev2 = n(c, 'sev2');
  const blocked = n(c, 'blockedFlows');
  const open = n(c, 'openClarifications');
  const stale = status?.staleness?.length ?? n(c, 'staleStages') ?? 0;
  if (sev1) parts.push(`${sev1}×Sev-1`);
  if (sev2) parts.push(`${sev2}×Sev-2`);
  if (blocked) parts.push(`${blocked} blocked`);
  if (open) parts.push(`${open} open Q`);
  if (stale) parts.push(`${stale} stale`);
  return parts.join(', ');
}

/** Full findings breakdown for the integration tooltip (every meaningful count). */
function findingsLines(status: IntegrationStatus | null): string[] {
  const c = status?.counts;
  if (!c) return [];
  const rows: [string, number | undefined][] = [
    ['Sev-1', n(c, 'sev1')],
    ['Sev-2', n(c, 'sev2')],
    ['Sev-3', n(c, 'sev3')],
    ['Blocked flows', n(c, 'blockedFlows')],
    ['Open clarifications', n(c, 'openClarifications')],
    ['Azure Function deps', n(c, 'azureFunctionDeps')],
    ['Local function deps', n(c, 'localFunctionDeps')],
    ['MSIs cracked', n(c, 'msisCracked')],
  ];
  const lines = rows.filter(([, v]) => v !== undefined).map(([k, v]) => `- ${k}: ${v}`);
  return lines;
}

/** Non-gating stages — when `missing` they are optional / not-applicable, not a gap. */
const OPTIONAL_STAGES = new Set(['3a', '6', '6a']);

/** Map a stage status to an icon + theme color, reusing the web tool's pill semantics. */
function stageIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case 'done':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    case 'covered':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.blue'));
    case 'blocked':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'stale':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    case 'missing':
    default:
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.yellow'));
  }
}

/**
 * A `done` stage whose primary artifact has only been *generated*, not yet
 * *executed / verified*. Today this is the Tests stage (11): `/implement-azure`
 * authors the MSTest project, so the csproj exists and the stage flips to `done`
 * — but the tests have NOT actually run until `/test-azure` executes `dotnet test`
 * and writes `tests-mstest/test-results.json` (which rewrites the summary to
 * "MSTest executed: N/total passed", or flips the stage to `blocked` on failure).
 *
 * Without this distinction a freshly-generated Tests stage renders identically to
 * a verified pass (green ✓ "done"), which reads as "tests passed" when they have
 * never run. Such a stage must instead read as "ready to run".
 */
function isGeneratedNotExecuted(stage: Stage): boolean {
  return stage.id === '11' && stage.status === 'done' && /not yet executed/i.test(stage.summary ?? '');
}

export class DomainNode extends vscode.TreeItem {
  /** Folder-relative path to the domain.yaml, if one exists. */
  public readonly domainYaml?: string;

  constructor(
    public readonly domain: string,
    public readonly folders: string[],
    hasDomainYaml: boolean,
  ) {
    super(domain, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('folder-library');
    this.description = `${folders.length} integration${folders.length === 1 ? '' : 's'}`;
    this.contextValue = hasDomainYaml ? 'domain domain-yaml' : 'domain';
    if (hasDomainYaml) this.domainYaml = `specs/${domain}/domain.yaml`;
  }
}

export class IntegrationNode extends vscode.TreeItem {
  constructor(
    public readonly folder: string,
    public readonly status: IntegrationStatus | null,
    isActive: boolean,
    displayLabel?: string,
  ) {
    super(displayLabel ?? folder, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'integration';
    this.iconPath = new vscode.ThemeIcon(isActive ? 'target' : 'folder');
    const next = status?.next?.command;
    const badge = findingsBadge(status);
    const bits: string[] = [];
    if (isActive) bits.push('active');
    if (next) bits.push(`next: ${next.split(/\s+/)[0]}`);
    if (badge) bits.push(badge);
    this.description = bits.join(' · ');

    // A red/yellow icon when there are unresolved findings draws the eye to a
    // migration that needs attention; otherwise the plain folder/target icon.
    const hasBlocker = (n(status?.counts, 'sev1') ?? 0) > 0 || (n(status?.counts, 'blockedFlows') ?? 0) > 0;
    const hasWarning =
      (n(status?.counts, 'sev2') ?? 0) > 0 || (status?.staleness?.length ?? 0) > 0 || (n(status?.counts, 'openClarifications') ?? 0) > 0;
    if (hasBlocker) {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    } else if (hasWarning) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    } else {
      this.iconPath = new vscode.ThemeIcon(isActive ? 'target' : 'folder');
    }

    const findings = findingsLines(status);
    const cov = status?.coverage;
    const coverageLine =
      cov && (cov.flowsTotal !== undefined || cov.mappingsTotal !== undefined)
        ? `**Coverage** — flows w/ tests ${cov.flowsWithTests ?? 0}/${cov.flowsTotal ?? 0}, mappings documented ${cov.mappingsDocumented ?? 0}/${cov.mappingsTotal ?? 0}`
        : '';
    const blockedLine = status?.blockedFlowIds?.length
      ? `**Blocked flows**: ${status.blockedFlowIds.map((i) => `\`${i}\``).join(', ')}`
      : '';
    const tip = new vscode.MarkdownString(
      [
        `**${folder}**`,
        isActive ? '_active integration_' : '',
        status?.activePlatform ? `platform: \`${status.activePlatform}\`` : '',
        next ? `next: \`${next}\`${status?.next?.reason ? ` — ${status.next.reason}` : ''}` : '',
        findings.length ? `**Findings**\n\n${findings.join('\n')}` : '',
        coverageLine,
        blockedLine,
        status?.staleness?.length
          ? `**Stale** (${status.staleness.length})\n\n` +
            status.staleness
              .map((s) => `- stage ${s.stage}${s.stagename ? ` ${s.stagename}` : ''}: ${s.reason ?? `older than ${s.stalerThan ?? 'an upstream source'}`}`)
              .join('\n')
          : '',
        status?.generatedAt ? `_refreshed ${status.generatedAt}_` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    this.tooltip = tip;
  }
}

/**
 * A BizTalk solution — the top-level migration node. Frames the three-stage flow:
 * 1. Analyse (inventory + catalogue, done), 2. Migrate (one row per catalogue
 * group — migrated groups expand to their integration; unmigrated groups offer a
 * Migrate action), 3. Deploy (each migrated integration's own Deploy stage).
 */
export class BiztalkSolutionNode extends vscode.TreeItem {
  constructor(public readonly solution: BiztalkSolution) {
    super(solution.domain, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'biztalkSolution';
    this.iconPath = new vscode.ThemeIcon('history');

    const migrated = solution.groups.filter((g) => g.migrated).length;
    const total = solution.groups.length;
    const bits = ['BizTalk solution'];
    if (total) bits.push(`${migrated}/${total} groups migrated`);
    if (solution.artifacts !== undefined) bits.push(`${solution.artifacts} artifacts`);
    this.description = bits.join(' · ');

    this.tooltip = new vscode.MarkdownString(
      [
        `**${solution.folder}** — BizTalk solution`,
        total ? `Groups migrated: **${migrated} / ${total}**` : 'No catalogue groups parsed.',
        solution.artifacts !== undefined
          ? `Artifacts inventoried: **${solution.artifacts}**${solution.manual ? ` (${solution.manual} manual)` : ''}`
          : '',
        '**1. Analyse** ✓ · **2. Migrate** a group → spec + contracts + IR (unattended) · **3. Deploy** the resulting integration.',
        'Each catalogue group migrates independently into its own integration. Use **Migrate Group** on an un-migrated group, or **Run Full Pipeline** to migrate the whole solution at once.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }
}

/**
 * One catalogue integration boundary (INT-NNN) that has NOT been migrated yet.
 * Clicking it (or its inline ▶) migrates just this group via
 * `/run-pipeline --mode biztalk --unattended --group INT-NNN`.
 */
export class BiztalkGroupNode extends vscode.TreeItem {
  constructor(
    public readonly solutionFolder: string,
    public readonly group: BiztalkGroup,
  ) {
    super(`${group.id}  ${group.name}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'biztalkGroup';
    this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.yellow'));
    this.description = 'not migrated · ▶ migrate';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${group.id} ${group.name}** — not migrated`,
        'Click to migrate just this group: runs `/run-pipeline --mode biztalk --unattended --group ' + group.id + '`, producing its own spec, contracts, IR and (on through the pipeline) a deployable integration.',
      ].join('\n\n'),
    );
    this.command = { command: 'spec2integration.migrateGroup', title: 'Migrate group', arguments: [this] };
  }
}

/**
 * A pipeline-stage row under a {@link PreIntegrationNode}. Renders the full
 * roadmap before any `status.json` exists: `0a`/`0b` are `done` (and open their
 * artifact); every later stage is `pending` (informational — the single correct
 * action lives on the parent node as "Reverse-engineer"). `isNext` marks the
 * first stage `/biztalk-reverse-engineer` will produce.
 */
export class PreStageNode extends vscode.TreeItem {
  public readonly artifactRel?: string;

  constructor(
    public readonly folder: string,
    stageId: string,
    name: string,
    opts: { artifactRel?: string; isNext?: boolean } = {},
  ) {
    super(`${stageId}  ${name}`, vscode.TreeItemCollapsibleState.None);
    this.artifactRel = opts.artifactRel;
    const done = !!opts.artifactRel;
    this.iconPath = done
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.yellow'));
    this.description = done ? `done · ${opts.artifactRel}` : 'pending';

    if (done) {
      this.contextValue = 'stage artifact previewable';
      this.tooltip = new vscode.MarkdownString(`📄 click to open \`${opts.artifactRel}\``);
      this.command = { command: 'spec2integration.openArtifact', title: 'Open artifact', arguments: [this] };
    } else if (opts.isNext) {
      // The first pending stage is the kick-off point: clicking it (or its inline
      // ▶ button) runs /biztalk-reverse-engineer, which produces stages 1–5.
      this.iconPath = new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.blue'));
      this.description = 'pending · ▶ run /biztalk-reverse-engineer';
      this.contextValue = 'preStage preStageNext';
      this.tooltip = new vscode.MarkdownString(
        [
          `**${stageId} ${name}** — pending · next`,
          'Click to run **`/biztalk-reverse-engineer`** — it authors the spec, contracts and IR (stages 1–5) from the inventory; the integration then appears here with live stage statuses.',
        ].join('\n\n'),
      );
      this.command = { command: 'spec2integration.runReverseEngineer', title: 'Reverse-engineer', arguments: [] };
    } else {
      this.contextValue = 'preStage';
      this.tooltip = new vscode.MarkdownString(
        [
          `**${stageId} ${name}** — pending`,
          'Not produced yet. Produced by **`/biztalk-reverse-engineer`** (stages 1–5) or the stage that follows it once the integration appears.',
        ].join('\n\n'),
      );
    }

    if (opts.isNext) {
      const text = `${stageId}  ${name}`;
      this.label = { label: text, highlights: [[0, text.length]] };
    }
  }
}

export interface StageNodeOpts {
  staleness?: StalenessEntry;
  /** Folder-relative path of the stage's primary artifact, if it exists. */
  artifactRel?: string;
  /** Folder-relative path of the stage's report, if it exists. */
  reportRel?: string;
}

export class StageNode extends vscode.TreeItem {
  public readonly artifactRel?: string;
  public readonly reportRel?: string;
  /** Live deployed-app URL parsed from a `done` Deploy (stage 12) summary, if any. */
  public readonly deployedUrl?: string;

  constructor(
    public readonly folder: string,
    public readonly stage: Stage,
    isNext: boolean,
    opts: StageNodeOpts = {},
  ) {
    super(`${stage.id}  ${stage.name}`, vscode.TreeItemCollapsibleState.None);
    this.artifactRel = opts.artifactRel;
    this.reportRel = opts.reportRel;
    // Deploy (12): surface the live URL from the summary so the row opens the
    // running app (browser), while the 📄 icon still opens azure.yaml.
    if (stage.id === '12' && stage.status === 'done') {
      const m = (stage.summary || '').match(/https?:\/\/[^\s)]+/);
      if (m) this.deployedUrl = m[0].replace(/[.,;]+$/, '');
    }
    // Optional / non-gating stage that simply hasn't run → muted, not a yellow gap.
    const optional = OPTIONAL_STAGES.has(stage.id) && stage.status === 'missing';
    this.iconPath = optional ? new vscode.ThemeIcon('circle-slash') : stageIcon(stage.status);
    const staleReason =
      stage.status === 'stale' && opts.staleness
        ? opts.staleness.reason ?? `older than ${opts.staleness.stalerThan ?? 'an upstream source'}`
        : undefined;
    // For a stale stage the reason is more useful than the generic summary.
    const detail = staleReason ?? stage.summary;
    this.description = optional ? `optional · ${stage.summary || 'not run'}` : `${stage.status}${detail ? ' · ' + detail : ''}`;
    // A `done` stage that is only *generated* (tests authored but never run) must
    // not look like a verified pass. Render it as "ready to run" — a distinct blue
    // beaker icon (not the green ✓) and a "generated · not yet run" description —
    // so the row reads as an action still owed, not a completed one.
    const generatedNotExecuted = isGeneratedNotExecuted(stage);
    if (generatedNotExecuted) {
      this.iconPath = new vscode.ThemeIcon('beaker', new vscode.ThemeColor('charts.blue'));
      this.description = `generated · not yet run${detail ? ' · ' + detail : ''}`;
    }
    const runCmd = STAGE_CMD[stage.id];
    this.tooltip = new vscode.MarkdownString(
      [
        `**${stage.id} ${stage.name}** — ${generatedNotExecuted ? 'generated, not yet run' : stage.status}`,
        stage.summary ?? '',
        generatedNotExecuted ? '🧪 The test project is generated but has not run. Click ▶ or run `/test-azure` to execute the tests.' : '',
        staleReason ? `⚠ stale: ${staleReason}` : '',
        isNext ? '→ recommended next step' : '',
        this.deployedUrl ? `🌐 click to open the deployed app — ${this.deployedUrl}` : '',
        this.artifactRel ? `📄 ${this.deployedUrl ? 'azure.yaml' : 'click to open'} \`${this.artifactRel}\`` : '',
        this.reportRel ? `📑 report: \`${this.reportRel}\`` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );

    // contextValue is a space-joined tag set; menus match with `viewItem =~ /\btag\b/`.
    const tags = ['stage'];
    if (runCmd) tags.push('runnable');
    if (this.deployedUrl) tags.push('deployed');
    if (this.artifactRel) tags.push('artifact');
    // Artifacts with a richer rendered view get an Open Preview action:
    // Markdown → Markdown preview; integration-ir.yaml → the IR graph visualizer.
    if (this.artifactRel && /(\.md|integration-ir\.ya?ml)$/i.test(this.artifactRel)) tags.push('previewable');
    if (this.reportRel) tags.push('report');
    this.contextValue = tags.join(' ');

    // Default click: a deployed app opens its live URL; a generated-but-not-run
    // Tests stage RUNS (the owed action is execution, not navigation — the csproj
    // is still reachable via the 📄 inline button); else open the artifact
    // (navigation-first); else run the stage when there is no artifact yet.
    if (this.deployedUrl) {
      this.command = { command: 'spec2integration.openDeployedUrl', title: 'Open deployed app', arguments: [this] };
    } else if (generatedNotExecuted && runCmd) {
      this.command = { command: 'spec2integration.runStage', title: 'Run the tests', arguments: [this] };
    } else if (this.artifactRel) {
      this.command = { command: 'spec2integration.openArtifact', title: 'Open artifact', arguments: [this] };
    } else if (runCmd) {
      this.command = { command: 'spec2integration.runStage', title: 'Run this stage', arguments: [this] };
    }

    if (isNext) {
      const text = `${stage.id}  ${stage.name}`;
      this.label = { label: text, highlights: [[0, text.length]] };
    }
  }

  /** The folder-arg-safe command that advances/re-runs this stage, if any. */
  get stageCommand(): string | undefined {
    return STAGE_CMD[this.stage.id];
  }
}

export class PipelineTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private activeIntegration: string | null = null;

  constructor(private readonly repoRoot: string) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  private async integrationNode(folder: string, displayLabel?: string): Promise<IntegrationNode> {
    return new IntegrationNode(
      folder,
      await readStatus(this.repoRoot, folder),
      folder === this.activeIntegration,
      displayLabel,
    );
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.repoRoot) return []; // no workspace — welcome view renders instead
    if (!element) {
      const state = await readState(this.repoRoot);
      this.activeIntegration = state.activeIntegration ?? null;
      const folders = await discoverIntegrations(this.repoRoot);
      const solutions = await discoverBiztalkSolutions(this.repoRoot);
      const biztalkDomains = new Set(solutions.map((s) => s.domain));

      // Group `specs/<domain>/NNN-slug` folders under a domain node — EXCEPT
      // BizTalk-solution domains, whose integrations render under their
      // BiztalkSolutionNode. Keep top-level `specs/NNN-slug` folders at the root.
      const topLevel: string[] = [];
      const byDomain = new Map<string, string[]>();
      for (const f of folders) {
        const parts = f.split('/'); // ['specs', a, (b)]
        if (parts.length === 3) {
          if (biztalkDomains.has(parts[1])) continue; // handled by BiztalkSolutionNode
          let arr = byDomain.get(parts[1]);
          if (!arr) {
            arr = [];
            byDomain.set(parts[1], arr);
          }
          arr.push(f);
        } else {
          topLevel.push(f);
        }
      }

      const nodes: vscode.TreeItem[] = [];
      // BizTalk solutions first — the migration cockpit (Analyse / Migrate / Deploy).
      for (const sol of solutions) nodes.push(new BiztalkSolutionNode(sol));
      for (const domain of [...byDomain.keys()].sort()) {
        const hasYaml = await pathExists(path.join(this.repoRoot, 'specs', domain, 'domain.yaml'));
        nodes.push(new DomainNode(domain, byDomain.get(domain)!.sort(), hasYaml));
      }
      for (const f of topLevel) nodes.push(await this.integrationNode(f));
      return nodes;
    }

    if (element instanceof DomainNode) {
      return Promise.all(element.folders.map((f) => this.integrationNode(f)));
    }

    if (element instanceof BiztalkSolutionNode) {
      const sol = element.solution;
      const kids: vscode.TreeItem[] = [];
      // 1. Analyse — inventory + catalogue (done, openable).
      if (sol.inventoryRel) kids.push(new PreStageNode(sol.folder, '0a', 'Inventory', { artifactRel: sol.inventoryRel }));
      if (sol.catalogueRel) kids.push(new PreStageNode(sol.folder, '0b', 'Catalogue', { artifactRel: sol.catalogueRel }));
      // 2. Migrate — one row per catalogue group. Migrated groups expand to their
      //    integration (with its own stages incl. Deploy); unmigrated groups offer
      //    a Migrate action.
      for (const g of sol.groups) {
        if (g.migrated && g.integrationFolder) {
          kids.push(await this.integrationNode(g.integrationFolder, `${g.id}  ${g.name}`));
        } else {
          kids.push(new BiztalkGroupNode(sol.folder, g));
        }
      }
      // Legacy whole-solution integrations not tied to a catalogue group.
      for (const f of sol.ungroupedIntegrations) kids.push(await this.integrationNode(f));
      return kids;
    }

    if (element instanceof IntegrationNode) {
      const status = element.status;
      // Drop 0a/0b — Inventory & Catalogue are solution-wide and already shown
      // once on the BizTalk solution node; repeating them per integration is noise.
      const stages = (status?.stages ?? []).filter((s) => s.id !== '0a' && s.id !== '0b');
      const nextCmd = status?.next?.command?.split(/\s+/)[0];
      const nextStageId = nextCmd ? findStageForCommand(nextCmd, stages) : undefined;
      const staleByStage = new Map<string, StalenessEntry>();
      for (const s of status?.staleness ?? []) staleByStage.set(String(s.stage), s);
      return Promise.all(
        stages.map(async (s) => {
          const [artifactRel, reportRel] = await Promise.all([
            resolveArtifact(this.repoRoot, element.folder, s.id),
            resolveReport(this.repoRoot, element.folder, s.id),
          ]);
          return new StageNode(element.folder, s, s.id === nextStageId, {
            staleness: staleByStage.get(s.id),
            artifactRel,
            reportRel,
          });
        }),
      );
    }

    return [];
  }
}

/** Heuristic: which stage row does `next.command` point at (for highlighting). */
function findStageForCommand(command: string, stages: Stage[]): string | undefined {
  // earliest stale or non-done stage whose STAGE_CMD matches the next command
  for (const s of stages) {
    if (STAGE_CMD[s.id] === command && (s.status === 'missing' || s.status === 'stale' || s.status === 'blocked')) {
      return s.id;
    }
  }
  // fallback: first match regardless of status
  for (const s of stages) {
    if (STAGE_CMD[s.id] === command) return s.id;
  }
  return undefined;
}
