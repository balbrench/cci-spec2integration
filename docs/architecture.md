# Architecture

Spec2Integration is a hexagonal, two-layer agent system. All agents, commands, and skills live directly under [.claude/](../.claude/), which Claude Code auto-loads from the project root — no plugin manifest or marketplace registration. Naming prefix is the only grouping:

| Prefix | Role | Examples |
|---|---|---|
| (unprefixed) | Platform-neutral pipeline: PRD → spec → IR → plan → tasks, plus the validation agents | `integration-architect`, `planner`, `reviewer`, `ir-validator`, `pii-flow-checker` |
| `biztalk-*` | Brownfield source: reverse-engineers a BizTalk solution into the platform-neutral IR | `biztalk-msi-cracker`, `biztalk-inventory`, `biztalk-ir-compiler` |
| `azure-*` | Azure target platform: compiles the IR into deployable Azure artifacts | `azure-logic-apps-compiler`, `azure-functions-compiler`, `azure-data-factory-compiler`, `azure-bicep-author` |

Adding a new target platform means dropping `<plat>-*` agents, commands, and skills directly into [.claude/agents/](../.claude/agents/), [.claude/commands/](../.claude/commands/), and [.claude/skills/](../.claude/skills/) — see [platform-pack-guide.md](platform-pack-guide.md).

The internal agent layer remains intentionally granular, but the user-facing prompt layer is now grouped by role so users do not have to navigate the whole graph at once:

- `Guided` prompts orchestrate multiple stages. Examples: `/run-pipeline`, `/prepare-for-implementation`, `/biztalk-reverse-engineer`.
- `Manual` prompts move one primary artifact forward. Examples: `/specify`, `/clarify`, `/contracts`, `/architect`, `/implement-azure`.
- `Reporting` prompts explain current state without advancing the pipeline. Examples: `/next`, `/status`, `/visualize`, `/ir-diff`, `/drift-check`.
- `Recovery` prompts target a specific validation or unblock loop. Examples: `/review`, `/platform`, `/test-mappings`, `/test-flows`, `/test-azure`.
- `Advanced` prompts are optional specialist utilities. Example: `/domain`.

That grouping is a navigation aid only. It does not change the constitutional rule that each agent owns one primary artifact or concern.

```
PRD
 │
 ▼
┌──────────────────────────────────────────────────────────┐
│ Core agents  (platform-neutral, unprefixed)              │
│                                                          │
│  Pipeline producers (one agent, one artifact)            │
│  ─────────────────────────────────────────────           │
│  prd-author            → PRD.md                          │
│  requirements-analyst  → spec.md                         │
│  clarifier             → clarifications.md               │
│  domain-modeler        → data-model.md                   │
│  contract-designer     → contracts/                      │
│  mapping-designer      → mappings/ + IR.mappings         │
│  integration-architect → integration-ir.yaml   ← the port│
│  domain-architect      → domain.yaml           (optional)│
│  target-architecture   → target-architecture.md (optional)│
│  planner               → plan.md                         │
│  task-decomposer       → tasks.md                        │
│  reviewer              → review-report                   │
│                                                          │
│  Validation agents (run as gates inside /review)         │
│  ─────────────────────────────────────────────           │
│  ir-validator          → ir-validation-report            │
│  mapping-tester        → mapping-test-report             │
│  flow-tester           → flow-test-report                │
│  contract-linter       → contract-lint-report            │
│  stm-drift-checker     → stm-drift-report                │
│  secret-scanner        → secret-scan-report              │
│  pii-flow-checker      → pii-flow-report                 │
│  spec-coverage-checker → traceability-matrix             │
└──────────────────────────────────────────────────────────┘
        ▲                                          │
        │ (brownfield: feeds IR-shaped artifacts)  │ IR + contracts/
        │                                          ▼
┌──────────────────────────────────┐   ┌──────────────────────────────────────┐
│ BizTalk agents (biztalk-*)       │   │ Azure agents (azure-*)               │
│ reverse-engineering source       │   │ multi-host target platform           │
│                                  │   │                                      │
│  biztalk-msi-cracker             │   │  Per-flow compilers (host-routed):   │
│      → _extracted/               │   │   azure-logic-apps-compiler    → app/│
│  biztalk-inventory               │   │   azure-functions-compiler     → FunctionApps/│
│      → inventory + catalogue     │   │   azure-data-factory-compiler  → adf/│
│  biztalk-spec-author    → spec.md│   │   azure-local-functions-author → Functions/│
│  biztalk-contract-extractor      │   │                                      │
│      → contracts/                │   │  Shared cross-flow agents:           │
│  biztalk-ir-compiler             │   │   azure-connections-binder → connections.json│
│      → integration-ir.yaml +     │   │   azure-bicep-author       → infra/*.bicep│
│        artifacts/custom/         │   │   azure-workflow-tester    → tests-mstest/│
└──────────────────────────────────┘   │   azure-cicd-author        → .github/│
                                       │   azure-reviewer           → azure-review.md│
                                       └──────────────────────────────────────┘
```

The BizTalk pack feeds the same IR-shaped artifacts (`spec.md`, `contracts/`, `integration-ir.yaml`) that greenfield core agents produce, so once reverse engineering is done the rest of the core pipeline (`/clarify`, `/plan`, `/tasks`) runs unchanged. A BizTalk solution can be migrated **per catalogue group**: `/biztalk-reverse-engineer --group INT-NNN` (and `/run-pipeline --mode biztalk --group INT-NNN`) scope the run to one `INT-NNN` boundary — the `biztalk-*` agents honor a `Source group` scope and stamp `source.group` / `source.groupName` into the IR, so each group becomes its own integration folder; omitting `--group` collapses the whole solution into one combined integration. The Azure pack reads only the IR + contracts and produces a multi-host solution: each flow is routed by `flows[].implementation.host` to Logic Apps Standard, a stand-alone Function App, or Data Factory — each compiler is skipped when its bucket is empty.

## Artifact hierarchy

```
kind: Domain          (domain.yaml — business domain, groups integrations)
  └── kind: Integration  (integration-ir.yaml — one deployable unit)
        └── flow          (flows[].layer: experience | process | system)
              └── step    (EIP node)
```

The Domain artifact sits at the domain folder level, with integrations nested underneath:

```
specs/
  order-management/
    domain.yaml                          # kind: Domain
    contracts/schemas/OrderCreated.json  # canonical domain event schemas
    001-order-intake/
      integration-ir.yaml                # kind: Integration, metadata.domain: order-management
    002-order-orchestration/
      integration-ir.yaml                # kind: Integration, metadata.domain: order-management
    003-sap-order-adapter/
      integration-ir.yaml                # kind: Integration, metadata.domain: order-management
```

## Why an IR?

The Integration IR (`integration-ir.yaml`) is an explicit, validated, EIP-aligned description of the integration. It is the only thing a platform pack is allowed to depend on. This makes every platform pack a pure function of `(IR, contracts, constitution)` -> platform artifacts, and lets us swap packs without touching the core pipeline.

### Article II.a \u2014 Asset Preservation in Migration Scenarios

When `metadata.scenario: migration`, the compiler MUST preserve original platform artifacts (schemas, maps) byte-for-byte from `source.artifactsRoot`. Per-target adaptation occurs only via declared `transforms` adapters; in-IR `rules` for a preserved mapping are documentation only and MUST NOT be re-emitted. Article II (IR-first) continues to govern artifacts where `origin: authored`.

This article exists because reverse-engineered XSLT, DataWeave, Groovy, etc. is the production source of truth on the legacy platform. Re-deriving it from a partial IR rule set would silently change semantics. Packs ship the original artifact unchanged (`transforms.<pack>: passthrough`) or run a declared, named adapter (e.g. `xslt_to_dataweave`); they never invent transformation logic from a `preserved` mapping's commentary.

## Single-responsibility agents

Every core agent produces **one** primary artifact. Secondary edits go through `reviewer`. This mirrors BMAD-METHOD's "one agent, one artifact" pattern and keeps context windows lean.

## Governance

The constitution lives in [CLAUDE.md](../CLAUDE.md) at the repo root. `reviewer` checks every artifact against it. `planner` refuses to proceed if `reviewer` reports violations. `planner` also refuses if no target platform is selected (`/platform <name>` must be run first).

## State

The active platform pack is recorded in `.spec2integration/state.json`. This is the only mutable state the pipeline keeps.

### State file scope and precedence

Two locations are recognised:

| Location | Scope |
|---|---|
| `<repo-root>/.spec2integration/state.json` | Repo-level default — applies when no example-level file exists. |
| `<example-dir>/.spec2integration/state.json` | Per-example override — applies only within that example's directory tree. |

**Lookup rule:** when any agent resolves state, it walks up from the current working directory toward the repo root and uses the first `state.json` it finds. A per-example file therefore always wins over the repo-level file. If neither exists, agents that require a platform selection (e.g. `/plan`, `/implement-*`) will stop and prompt the user to run `/platform <name>` first.

## Phase-gate ordering

Commands enforce the following gate sequence. Each gate must pass before the next command is accepted.

For new users, do not read this list as the required day-to-day command menu. The recommended entry points are:

- Guided full path: `/run-pipeline`
- Guided pre-implementation slice: `/prepare-for-implementation`
- Quick orientation: `/next` or `/status`

The sequence below is the canonical manual execution order and the architecture-level gate model.

```
/specify   → spec.md
/clarify   → clarifications.md (1st run); spec.md folded with signed-off OQs (re-run)
/model     → data-model.md
/contracts → contracts/  ──► contract-linter gate (PASS required; Phase 8: IR-round-trip divergence)
/map       → mappings/ + IR mappings block
/architect → integration-ir.yaml
/test-mappings ──► mapping-tester gate (PASS required before /plan)
/test-flows     ──► flow-tester gate (optional; runs when flows declare tests[])
/platform  → .spec2integration/state.json
/plan      → plan.md  ──► mapping-tester gate runs here if not already passed
/tasks     → tasks.md
/review    → review-report  ──► ir-validator → stm-drift-checker → secret-scanner → pii-flow-checker → flow-tester (if declared) → reviewer
/implement-<plat> → platform artifacts ──► secret-scanner gate on output
/test-<plat>
/deploy-<plat>
```

The manual order above is intentionally more detailed than the recommended prompt surface. Guided prompts collapse these stages for usability while preserving the same gates.

### Validation agents and their gates

| Agent | Triggered by | Blocks on |
|---|---|---|
| `ir-validator` | `/review` (step 1) | Sev-1: broken refs, schema violations, endpoint/OpenAPI divergence |
| `stm-drift-checker` | `/review` (step 2) | Sev-2: STM docs out of sync with IR |
| `secret-scanner` | `/review` (integration folder); `/implement-*` (output dir) | Sev-1: any detected secret |
| `reviewer` | `/review` (step 4) | Sev-1 blocks; Sev-2 blocks unless `--allow-sev2` |
| `mapping-tester` | `/test-mappings`; `/plan` | Sev-1: fixture failures, missing runtime |
| `flow-tester` | `/test-flows` | Sev-1: flow-test failures, missing runtime |
| `contract-linter` | `/contracts` (final step) | Sev-1: Spectral errors, ajv compile failures, IR-round-trip divergence |
| `pii-flow-checker` | `/review` | Sev-1: PII field reaching a public channel without redact |

### Commands added in Phases 1–4

| Command | Plugin | Purpose |
|---|---|---|
| `/test-mappings` | core | Execute JSONata fixture tests for every mapping |
| `/ir-diff <base> <changed>` | core | Classify IR changes as breaking / additive / cosmetic |
| `/visualize` | core | Render IR flows as Mermaid into `docs/generated/flows.md` |
| `/drift-check` | core | Verify generated artifact hashes against `state.json` baseline |

### Commands added in Phase 8

| Command | Plugin | Purpose |
|---|---|---|
| `/test-flows` | core | Drive `flows[].tests[]` through the in-process interpreter and assert emitted messages, reached steps, and DLQ envelopes |

### IR as contract source of truth (Phase 8)

The IR is authoritative over `contracts/openapi.yaml` and `contracts/asyncapi.yaml`.

- `contract-designer` projects IR endpoint detail (method, path, requestBody, responses, parameters, idempotencyHeader, rateLimit, cors) and IR `channel.binding` fields into the OpenAPI / AsyncAPI docs.
- `ir-validator` and `contract-linter` both run a round-trip divergence check. When they disagree, the fix is always to edit the IR and regenerate — never to hand-edit the contract.
- This keeps Article II enforceable: platform packs consume only the IR + contracts, and they never need to parse OpenAPI for transport detail.
