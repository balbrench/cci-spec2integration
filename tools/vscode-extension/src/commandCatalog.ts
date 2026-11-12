// Command catalog — the arg schema for every slash command the wizard can compose.
//
// The stage id -> command table (`stageCommand`) is loaded from
// schemas/stage-dependencies.json at activation (see setStageCommands), not kept
// by hand. No `vscode` import: this module is unit-tested in plain Node.

/** A single wizard step for one command argument. */
export type ArgSpec =
  | {
      kind: 'folder';
      // Positional repo-relative integration folder. Defaults to the selected /
      // active integration; the wizard skips the prompt when a default is known.
      optional?: boolean;
    }
  | {
      kind: 'choice';
      flag?: string; // omit for a positional value; set e.g. "--mode" for "--mode greenfield"
      title: string;
      options: { label: string; value: string; description?: string }[];
      optional?: boolean;
    }
  | {
      kind: 'flags';
      title: string;
      options: { label: string; flag: string; description?: string }[];
    }
  | {
      kind: 'text';
      flag?: string; // omit for a positional (quoted) value
      title: string;
      placeholder?: string;
      quote?: boolean; // wrap value in double quotes (default true for free text)
      optional?: boolean;
    }
  | {
      kind: 'path';
      flag?: string;
      title: string;
      canPickFiles?: boolean; // default true
      canPickFolders?: boolean; // default false
      optional?: boolean;
    }
  | {
      kind: 'count';
      flag: string;
      title: string;
      placeholder?: string;
      optional?: boolean;
    };

export interface CommandSpec {
  command: string; // includes leading slash
  label: string; // human label for the picker
  detail: string; // one-line description
  group: 'Intake' | 'Core' | 'Test' | 'Review' | 'Platform' | 'Reporting' | 'Maintenance' | 'Guided' | 'BizTalk';
  args: ArgSpec[];
}

/** Stages a row can't re-run with just the folder: /specify takes a PRD and
 *  /platform takes a pack name. They stay reachable through Compose. */
export const NOT_ROW_RUNNABLE: readonly string[] = ['1', '7'];

let stageCommands: Record<string, string> = {};

/** Install the stage id -> command table (built by stageMap.stageCommandTable). */
export function setStageCommands(table: Record<string, string>): void {
  stageCommands = { ...table };
}

/** The command that advances or re-runs a stage, if a row can run it. */
export function stageCommand(stageId: string): string | undefined {
  return stageCommands[stageId];
}

/**
 * Which stage does `command` (the first token of status.next.command) advance?
 * The earliest missing / stale / blocked stage it produces, else the first
 * stage it produces. Shared by the tree, the progress view and the stage graph
 * so all three highlight the same "next" stage.
 */
export function findStageForCommand(
  command: string,
  stages: readonly { id: string; status: string }[],
): string | undefined {
  for (const s of stages) {
    if (stageCommand(s.id) === command && (s.status === 'missing' || s.status === 'stale' || s.status === 'blocked')) {
      return s.id;
    }
  }
  for (const s of stages) if (stageCommand(s.id) === command) return s.id;
  return undefined;
}

/** Canonical ordered pipeline stages (id → display name), mirroring the stage
 *  table in `.claude/skills/pipeline-status/SKILL.md`. Used to render the full
 *  roadmap for a BizTalk pre-integration before any `status.json` exists. */
export const PIPELINE_STAGES: { id: string; name: string }[] = [
  { id: '0a', name: 'Inventory' },
  { id: '0b', name: 'Catalogue' },
  { id: '1', name: 'Spec' },
  { id: '1a', name: 'Clarifications' },
  { id: '2', name: 'Data model' },
  { id: '3', name: 'Contracts' },
  { id: '3a', name: 'Contracts lint' },
  { id: '4', name: 'Mappings (STM)' },
  { id: '5', name: 'IR' },
  { id: '5a', name: 'IR validation' },
  { id: '5b', name: 'STM drift' },
  { id: '5c', name: 'Secret scan' },
  { id: '5d', name: 'PII flow' },
  { id: '5e', name: 'Review' },
  { id: '6', name: 'Mapping tests' },
  { id: '6a', name: 'Flow tests' },
  { id: '7', name: 'Platform pack' },
  { id: '8', name: 'Plan' },
  { id: '9', name: 'Tasks' },
  { id: '10', name: 'Implement' },
  { id: '11', name: 'Tests' },
  { id: '12', name: 'Deploy' },
];

const folderOnly = (
  command: string,
  label: string,
  detail: string,
  group: CommandSpec['group'],
): CommandSpec => ({ command, label, detail, group, args: [{ kind: 'folder' }] });

export const COMMANDS: CommandSpec[] = [
  // ---- Guided ----
  {
    command: '/run-pipeline',
    label: '/run-pipeline — end-to-end orchestrator',
    detail: 'Intake → tests, gating on status.json between stages (stops before deploy).',
    group: 'Guided',
    args: [
      {
        kind: 'choice',
        flag: '--mode',
        title: 'Pipeline mode',
        options: [
          { label: 'greenfield', value: 'greenfield', description: 'Start from a PRD or brief' },
          { label: 'biztalk', value: 'biztalk', description: 'Reverse-engineer a BizTalk solution' },
        ],
      },
      {
        kind: 'text',
        flag: '--input',
        title: 'Input — a brief (greenfield) or a source path (biztalk)',
        placeholder: 'e.g. Order intake from HTTP, validate, publish to Service Bus',
        optional: true,
      },
      {
        kind: 'flags',
        title: 'Flags (space to toggle, Enter to confirm)',
        options: [
          { label: 'auto-accept clarifications', flag: '--auto-accept-clarifications', description: 'Use demo defaults for open questions' },
          { label: 'unattended', flag: '--unattended', description: 'Do not stop at human touchpoints' },
          { label: 'allow Sev-2', flag: '--allow-sev2', description: 'Proceed while Sev-2 findings are tracked' },
          { label: 'dry run', flag: '--dry-run', description: 'Plan the run without executing stages' },
        ],
      },
      { kind: 'count', flag: '--auto-fix', title: 'Auto-fix attempts (optional, blank to skip)', placeholder: 'e.g. 2', optional: true },
    ],
  },
  {
    command: '/prepare-for-implementation',
    label: '/prepare-for-implementation — platform → review → plan → tasks',
    detail: 'Prepare an existing IR for implementation.',
    group: 'Guided',
    args: [{ kind: 'folder' }],
  },

  // ---- Intake / core ----
  {
    command: '/draft-prd',
    label: '/draft-prd — turn a brief into a PRD',
    detail: 'Create or enrich specs/PRD.md from a rough brief.',
    group: 'Intake',
    args: [
      { kind: 'text', title: 'Integration brief', placeholder: 'a few sentences describing the integration', optional: true },
    ],
  },
  {
    command: '/specify',
    label: '/specify — PRD → spec.md',
    detail: 'Produce a rigorous spec.md (or update in place).',
    group: 'Core',
    args: [
      { kind: 'path', title: 'PRD file (optional — blank to use specs/PRD.md or a direct instruction)', canPickFiles: true, optional: true },
      { kind: 'flags', title: 'Flags', options: [{ label: 'fresh (rewrite spec from scratch)', flag: '--fresh' }] },
    ],
  },
  folderOnly('/clarify', '/clarify — resolve open questions', 'Produce clarifications.md and fold answers back into spec.md.', 'Core'),
  folderOnly('/model', '/model — data-model.md', 'Entities, events, invariants, identity fields.', 'Core'),
  folderOnly('/contracts', '/contracts — OpenAPI + AsyncAPI + schemas', 'Generate and lint contracts.', 'Core'),
  folderOnly('/map', '/map — mappings + STM docs', 'Platform-neutral mappings block of the IR.', 'Core'),
  folderOnly('/architect', '/architect — integration-ir.yaml', 'Vendor-neutral, EIP-aligned IR.', 'Core'),
  folderOnly('/plan', '/plan — plan.md', 'Enforces constitution phase gates.', 'Core'),
  folderOnly('/tasks', '/tasks — tasks.md', 'Atomic, TDD-ordered task list.', 'Core'),

  // ---- Review ----
  {
    command: '/review',
    label: '/review — constitution audit',
    detail: 'Audit every artifact against the constitution.',
    group: 'Review',
    args: [
      { kind: 'folder' },
      { kind: 'flags', title: 'Flags', options: [{ label: 'allow Sev-2 (track, do not block)', flag: '--allow-sev2' }] },
    ],
  },

  // ---- Tests ----
  folderOnly('/test-mappings', '/test-mappings — run mapping fixtures', 'Evaluate mapping test fixtures.', 'Test'),
  folderOnly('/test-flows', '/test-flows — run flow fixtures', 'Execute flow test fixtures from the IR.', 'Test'),

  // ---- Platform ----
  {
    command: '/platform',
    label: '/platform — select the active platform pack',
    detail: 'Writes .spec2integration/state.json.',
    group: 'Platform',
    args: [
      {
        kind: 'choice',
        title: 'Platform pack',
        options: [{ label: 'azure', value: 'azure', description: 'Azure Integration Services (Logic Apps Standard, Functions, ADF)' }],
      },
    ],
  },
  folderOnly('/implement-azure', '/implement-azure — compile IR to Azure artifacts', 'Workflows, connections, Bicep, tests, CI/CD.', 'Platform'),
  folderOnly('/test-azure', '/test-azure — run MSTest suites', 'Run the generated Logic Apps unit tests.', 'Platform'),
  folderOnly('/deploy-azure', '/deploy-azure — provision + deploy', 'azd provision and deploy.', 'Platform'),

  // ---- Reporting ----
  folderOnly('/status', '/status — full pipeline status', 'Rebuild and show the stage checklist.', 'Reporting'),
  folderOnly('/next', '/next — recommended next step', 'Shortest answer to "what now?".', 'Reporting'),
  folderOnly('/visualize', '/visualize — Mermaid flow diagram', 'Render IR flows to docs/generated/flows.md.', 'Reporting'),
  folderOnly('/drift-check', '/drift-check — verify generated artifacts', 'Compare artifacts against recorded hashes.', 'Reporting'),
  folderOnly('/analyze', '/analyze — cross-artifact consistency report', 'One read-only conflict table: coverage, orphans, drift, staleness.', 'Reporting'),
  folderOnly('/reconcile', '/reconcile — spec/IR vs generated artifacts', 'Declared-but-missing, implemented-but-undeclared, unconfirmed transforms. Advisory.', 'Reporting'),
  folderOnly('/idd', '/idd — Solution Design Document', 'Render the IR, contracts and decisions.md into docs/solution-design.md.', 'Reporting'),
  {
    command: '/use',
    label: '/use — set the active integration folder',
    detail: 'Pin the folder other commands default to.',
    group: 'Reporting',
    args: [{ kind: 'folder' }],
  },
  {
    command: '/ir-diff',
    label: '/ir-diff — compare two IRs',
    detail: 'Classify changes as breaking, additive, or cosmetic.',
    group: 'Reporting',
    args: [
      { kind: 'path', title: 'First integration-ir.yaml', canPickFiles: true },
      { kind: 'path', title: 'Second integration-ir.yaml', canPickFiles: true },
    ],
  },

  // ---- Maintenance ----
  {
    command: '/change',
    label: '/change — targeted edit to a deployed integration',
    detail: 'Route one change to the owning agent; records a DD-NN decision.',
    group: 'Maintenance',
    args: [
      { kind: 'text', title: 'Change description', placeholder: 'e.g. widen the staging email column to 320 chars' },
      { kind: 'folder' },
      { kind: 'text', flag: '--agent', title: 'Force the owning agent (optional, blank to auto-route)', placeholder: 'e.g. azure-sql-schema-author', quote: false, optional: true },
      { kind: 'flags', title: 'Flags', options: [{ label: 'dry run (show routing, edit nothing)', flag: '--dry-run' }] },
    ],
  },
  {
    command: '/lifecycle',
    label: '/lifecycle — show, freeze, or unfreeze an integration',
    detail: 'Freeze protects deployed artifacts from regeneration.',
    group: 'Maintenance',
    args: [
      {
        kind: 'choice',
        title: 'Action',
        options: [
          { label: 'show', value: '', description: 'Show the current lifecycle and frozen stages' },
          { label: 'freeze', value: 'freeze', description: 'Mark post-implementation; guarded commands refuse to regenerate' },
          { label: 'unfreeze', value: 'unfreeze', description: 'Re-open for regeneration' },
        ],
      },
      { kind: 'folder' },
      { kind: 'text', flag: '--stage', title: 'Freeze only these stage ids (optional, e.g. 10 or 5,10)', placeholder: '10', quote: false, optional: true },
    ],
  },

  // ---- BizTalk ----
  {
    command: '/biztalk-inventory',
    label: '/biztalk-inventory — catalog a BizTalk solution',
    detail: 'Produce the inventory and integration catalogue.',
    group: 'BizTalk',
    args: [{ kind: 'path', title: 'BizTalk solution folder', canPickFiles: false, canPickFolders: true }],
  },
  {
    command: '/biztalk-reverse-engineer',
    label: '/biztalk-reverse-engineer — full reverse-engineering pipeline',
    detail: 'Inventory → spec → contracts → IR.',
    group: 'BizTalk',
    args: [{ kind: 'path', title: 'BizTalk solution folder', canPickFiles: false, canPickFolders: true }],
  },
  {
    command: '/domain',
    label: '/domain — produce domain.yaml',
    detail: 'Group integrations into business domains.',
    group: 'Guided',
    args: [],
  },
];

export function findCommand(command: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.command === command);
}
