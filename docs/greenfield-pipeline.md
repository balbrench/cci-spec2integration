# Greenfield Pipeline

Step-by-step guide for running the Spec2Integration greenfield pipeline from a rough idea to deployed integration.

The command surface now uses a small role taxonomy so users can tell which prompts are meant to advance work versus inspect or recover it:

- `Guided` prompts orchestrate multiple stages for you. Start with `/run-pipeline` or, once the IR exists, `/prepare-for-implementation`.
- `Manual` prompts advance one artifact-producing stage at a time. Use these when you want to inspect outputs between steps.
- `Reporting` prompts explain current state without advancing the pipeline. Use `/next` for the shortest answer and `/status` for the full table.
- `Recovery` prompts target a specific validation or repair loop after a block.
- `Advanced` prompts are optional utilities that are usually only relevant for multi-integration or specialist workflows.

---

## Prerequisites

- Claude Code (CLI, VS Code extension, or claude.ai/code) with this workspace open
- Optionally the **Spec2Integration VS Code extension** (`tools/vscode-extension/`) for an in-IDE pipeline tree, guided command composer, and the IR visualizer
- For Azure deployment: Azure CLI, azd, .NET SDK

---

> **Tip — one-shot run.** Use `/run-pipeline --mode greenfield --input "<one-line brief>"` (or pass a path to an existing PRD) to execute every stage below up through `/test-azure` in a single command. For a longer, multi-line brief, put it in a file and pass `--input-file <path>` instead (the VS Code extension's **Run Pipeline** button does this for you via an editor) — a file is always treated as a brief, so `/draft-prd` still runs. The orchestrator gates on `<folder>/status.json` between stages and stops at every human touchpoint (open clarifications, Sev-1/Sev-2 findings, failing tests). To deliberately review the spec before the rest is built, add `--pause-after spec` (a one-time checkpoint; `--pause-after` also accepts `clarify`, `model`, `contracts`, `mappings`, `ir`, `review`). Resume after a fix or review with `/run-pipeline --mode greenfield --folder <folder>`. Deployment is intentionally excluded — invoke `/deploy-azure` yourself when ready.

> **Navigation tip.** Advancing prompts should end by asking `What do you want to do next?` in chat. The prompt should explain the recommendation first, then offer a few fixed choices such as the recommended command, a guided or recovery alternative, and `Stop here`. Treat that question as the fastest path; use `/status <folder>` when you want the full stage table.

> **Quick orientation.** Use `/next <folder>` when you only want the single recommended follow-up command and the main blocking counters without the full status table.

> **Staleness is tracked for you.** A `PostToolUse` hook re-probes `status.json` after every edit and compares mtimes against the stage dependency map. If you edit an upstream artifact (e.g. `spec.md`) after a downstream one already exists (e.g. `integration-ir.yaml`), the downstream stages flip to `stale` and `next` repoints at the rebuild — so `/next` and `/status` tell you what to regenerate without you having to remember. `/run-pipeline --folder <folder>` resumes from the earliest stale stage.

> **Choosing a path.** For first-time greenfield work, prefer the guided entry points. Use the manual stages below only when you want artifact-by-artifact control or need to stop and adjust outputs between stages.

---

## Stage 1 — Draft the PRD

**Prompt:** `/draft-prd`
**Agent:** `prd-author`
**Input:** A few sentences, bullet points, or a richer PRD draft describing the integration need
**Output:** `specs/PRD.md`

Type `/draft-prd` and paste your brief. The agent structures it into a formal PRD with purpose, triggers, actors, interface details, payload fields, wire formats, constraints, and open questions.

> **You can build the PRD up over several calls.** Re-running `/draft-prd "<more detail>"` **enriches the same `specs/PRD.md`** — the agent reads the existing PRD, merges your new input into the right sections (and fills in any `[ASSUMPTION: …]` your input answers), and preserves prior content and hand-edits. So you don't have to get everything into one brief: start rough, then add interfaces, field tables, constraints, or answers incrementally. Pass `--fresh` to discard the existing PRD and start over, and you can always hand-edit `specs/PRD.md` directly — it's plain Markdown and the one file you're meant to edit by hand.

For greenfield work, `/draft-prd` works best when the brief includes as many of these as you already know:
- source and destination systems
- inbound and outbound transport (`HTTP`, `Service Bus`, `SFTP`, file drop, etc.)
- input/output wire format (`JSON`, `XML`, `flat-file`, `CSV`, `binary`)
- important field names, types, and required/optional flags
- sample payloads or flat-file layout details
- validation rules, SLAs, and error-handling expectations

**Example input:**
> We need to receive orders from the e-commerce portal via HTTP, validate them, enrich with SAP pricing, and publish an OrderCreated event to a Service Bus topic.

---

## Stage 2 — Specify

**Prompt:** `/specify`
**Agent:** `requirements-analyst`
**Input:** `specs/PRD.md`
**Output:** `specs/<domain>/NNN-<slug>/spec.md`

Converts the PRD into rigorous user stories, functional requirements (FRs), and non-functional requirements (NFRs). Every FR is numbered and traceable back to the PRD.

> **Re-running `/specify` updates the same spec in place — it does not duplicate.** When a spec already exists, `/specify` enriches it instead of creating a new `NNN` folder:
> - `/specify "add an NFR: 5-second p95 latency"` or `/specify "the inbound Order message also carries a customerTier field"` — folds a **direct instruction** into the spec as a new numbered `FR`/`NFR` or a refined interface section, preserving everything else.
> - `/specify` (no argument, after you enriched `specs/PRD.md`) — **reconciles the spec against the changed PRD**, adding anything the PRD now states.
> - Editing `specs/PRD.md` also flips the **Spec** stage to `stale` (greenfield only) and points `/next` at `/specify`, so a PRD change is surfaced, not silently dropped.
> - Pass `--fresh` to force a brand-new integration spec instead. You can also hand-edit `spec.md` directly — it's an upstream source, so edits propagate downstream via staleness.

---

## Stage 3 — Clarify

**Prompt:** `/clarify`
**Agents:** `clarifier`, then `requirements-analyst` (fold-back mode)
**Input:** `spec.md` (and `clarifications.md` on re-runs)
**Output:** `clarifications.md`; on re-runs, an updated `spec.md`

First run produces `clarifications.md` — each OQ-N from spec.md gets candidate answers, the clarifier's recommendation, the evidence behind it, a confidence rating, and a `Resolved` flag (initially `false` for anything that needs a business decision). An empty **Resolution log** table sits at the bottom.

### Sign-off loop

1. Read each OQ in `clarifications.md`.
2. If you accept the recommendation as-is, change `**Resolved:** false` to `**Resolved:** true — accepted recommendation`. If you choose a different option, edit the `**Recommended:**` line first, then flip the flag.
3. Fill the matching row in the Resolution log: `Answer` (one short sentence), `Source` (link/ticket/email), `Decided by` (your name + role), `Date` (YYYY-MM-DD).
4. Re-run `/clarify <integration-folder>`. The `requirements-analyst` re-invocation folds every signed-off OQ into `spec.md`: the OQ-N reference is replaced by the chosen answer in the relevant FR/NFR, and the OQ-N entry is removed from the Open questions section. Un-signed-off OQs are left untouched.

> **Fast path:** run `/clarify <integration-folder> --auto-sign-off` to accept the clarifier's **Recommended** answer for every still-open OQ automatically — it sets `Resolved: true`, fills the Resolution log with provenance, and warns you about any low/medium-confidence answers it accepted so you can review them. Use this for demos or when you trust the recommendations; use the manual loop above when a human business decision is genuinely required.

An OQ is treated as signed off **only** when both the `Resolved: true` flag is set **and** all four Resolution log cells are populated. Either alone is ignored — this prevents accidental half-decisions from changing the spec.

> **Gate:** `/model` will not run while any Sev-1 OQ is still open. Re-run `/clarify` after every batch of sign-offs to keep `spec.md` in sync.

---

## Stage 4 — Model the Domain

**Prompt:** `/model`
**Agent:** `domain-modeler`
**Input:** `spec.md`, `clarifications.md`
**Output:** `data-model.md`

Produces the domain's entities (with identity fields and invariants), events (with correlation keys), commands, and lookups. Uses PascalCase for types and camelCase for fields.

---

## Stage 5 — Design Contracts

**Prompt:** `/contracts`
**Agent:** `contract-designer`, then `contract-linter`
**Input:** `spec.md`, `data-model.md`
**Output:** `contracts/openapi.yaml`, `contracts/asyncapi.yaml`, `contracts/schemas/<Entity>.json`

Produces wire-level contracts:
- **OpenAPI** for synchronous HTTP endpoints
- **AsyncAPI** for async channels (queues, topics)
- **JSON Schema** one per entity/event

The `contract-linter` runs automatically at the end — Spectral lints OpenAPI/AsyncAPI and ajv validates JSON Schemas.

> **Constitution Article I:** No flow may be designed before contracts exist.

---

## Stage 6 — Design Mappings

**Prompt:** `/map`
**Agent:** `mapping-designer`
**Input:** `spec.md`, `data-model.md`, `contracts/`
**Output:** IR `mappings:` block, `mappings/<MappingName>.md` (STM documents)

Creates platform-neutral source-to-target mappings using JSONata (default), XSLT, Liquid, or JSLT. Each mapping gets a human-readable STM document showing field-by-field transformations, plus test fixtures.

> **Constitution Article II-a:** All transforms must be expressed in portable engine syntax, never platform-specific syntax.

---

## Stage 7 — Architect the IR

**Prompt:** `/architect`
**Agent:** `integration-architect`
**Input:** `spec.md`, `data-model.md`, `contracts/`, `mappings/`
**Output:** `integration-ir.yaml`

The core artifact. Produces the vendor-neutral, EIP-aligned Integration IR containing:
- `channels[]` — transport endpoints
- `messages[]` — typed message definitions
- `mappings[]` — transformation rules
- `endpoints[]` — synchronous surfaces
- `flows[]` — orchestrations as EIP node graphs
- `errorHandling` — retry policies, DLQs
- `identity` — managed identity references
- `nonFunctionals` — SLOs, throughput targets

> **Constitution Article II:** No platform-specific file may be produced before the IR exists and validates.

#### Greenfield IR rules

A greenfield IR MUST:

- Set `metadata.scenario: greenfield`.
- MUST NOT set the top-level `source:` block.
- MUST NOT set `messages[].nativeSchemaSource` with `origin: preserved` (greenfield messages have no preserved native schema).
- MUST NOT set `mappings[].origin: preserved` or `mappings[].migrationHint: preserve` \u2014 those values are reserved for migration scenarios where an original platform artifact exists on disk. Use `origin: authored` (default) and pick `migrationHint: auto | local-function | azure-function | manual` when the mapping is too complex for the default engine.

If you find yourself wanting any of the migration-only fields, you are not doing greenfield work \u2014 switch to the [BizTalk Migration Pipeline](biztalk-pipeline.md).

---

## Stage 8 — Test Mappings and Flows

**Prompt:** `/test-mappings`, `/test-flows`
**Agents:** `mapping-tester`, `flow-tester`
**Input:** `integration-ir.yaml`, test fixtures
**Output:** `mapping-test-report.md`, `flow-test-report.md`

Runs all declared test fixtures through a deterministic interpreter. Mapping tests evaluate JSONata/XSLT expressions. Flow tests walk the DAG end-to-end, injecting trigger payloads and comparing emitted messages against expectations.

---

## Stage 9 — (Optional) Group into a Domain

**Prompt:** `/domain`
**Agent:** `domain-architect`
**Input:** All `integration-ir.yaml` files in the workspace
**Output:** `specs/<domain>/domain.yaml`

Groups related integrations, declares canonical domain events, sets domain-wide policies. Only needed when you have multiple integrations in the same business domain.

---

## Stage 10 — Review

**Prompt:** `/review`
**Agent:** `reviewer` (orchestrates `ir-validator`, `pii-flow-checker`, `stm-drift-checker`, `secret-scanner`)
**Input:** Everything in the integration folder
**Output:** `review-report.md`, `review-report.json`

Audits every artifact against the 9 constitutional articles. Produces findings at three severity levels:
- **Sev-1** — hard blocks (e.g., missing retry policy, PII on public channel without redaction)
- **Sev-2** — must fix before merge (e.g., tests after implementation, STM drift)
- **Sev-3** — advisory (naming, style)

> **Gate:** The planner will not produce `plan.md` while any Sev-1 violation is open.

---

## Stage 11 — Select Platform Pack

**Prompt:** `/platform`
**Input:** Platform name (e.g., `azure`)
**Output:** `.spec2integration/state.json` updated

Registers the active platform pack. Must be run before planning or implementation.

> **Shortcut.** If you do not need to pause between review, plan, and tasks, run `/prepare-for-implementation <folder> --platform azure` instead of stages 11 through 13 individually.

---

## Stage 12 — Plan

**Prompt:** `/plan`
**Agent:** `planner`
**Input:** `integration-ir.yaml`, all upstream artifacts, `.spec2integration/state.json`
**Output:** `plan.md`, `research.md`

Checks all phase gates (spec exists, clarifications resolved, data model exists, contracts exist, IR validates, platform selected, review clean) before producing a phased implementation plan.

---

## Stage 13 — Decompose Tasks

**Prompt:** `/tasks`
**Agent:** `task-decomposer`
**Input:** `plan.md`, `integration-ir.yaml`
**Output:** `tasks.md`

Breaks the plan into atomic, TDD-ordered tasks. Tests are always ordered before the implementation they verify. Parallelizable tasks are marked with `[P]`.

> **Constitution Article VII:** Unit tests must be ordered before their implementation.

---

## Stage 14 — Implement (Azure)

**Prompt:** `/implement-azure`
**Agents (orchestrated in this order, each skipped when its bucket is empty):** `azure-logic-apps-compiler`, `azure-functions-compiler`, `azure-data-factory-compiler`, `azure-local-functions-author`, `azure-connections-binder`, `azure-bicep-author`, `azure-workflow-tester`, `azure-cicd-author`, `azure-reviewer`
**Input:** `integration-ir.yaml`, `contracts/`, `tasks.md`
**Output:** Full Azure solution, with each IR flow routed by `flows[].implementation.host` (default `logic-app-standard`) into the matching output tree

| Agent | Bucket | Output |
|-------|--------|--------|
| `azure-logic-apps-compiler` | `logic-app-standard` | `app/<Flow>/workflow.json`, `app/host.json`, `app/Artifacts/Maps/`, `app/Artifacts/Schemas/` |
| `azure-functions-compiler` | `function-app` | `FunctionApps/<Flow>/<Flow>.csproj` + `Program.cs`, `host.json`, `Functions/`, `Models/`, `Mappings/` (one stand-alone .NET 8 isolated-worker project per flow) |
| `azure-data-factory-compiler` | `data-factory` | `adf/pipelines/<Flow>.json`, `adf/datasets/`, `adf/linkedServices/`, `adf/triggers/`, optional `adf/dataflows/` and `adf/integrationRuntimes/` |
| `azure-local-functions-author` | Logic Apps `InvokeFunction` targets | `Functions/<Project>.csproj` (in-proc WebJobs SDK), `Functions/<Name>.cs` per target (DLLs publish into `app/lib/custom/net8/`) |
| `azure-connections-binder` | Logic Apps only | `app/connections.json`, `app/parameters.json`, `app/appsettings.*.json`, `app/local.settings.json`, `app/.vscode/` |
| `azure-bicep-author` | All | `infra/main.bicep`, `infra/modules/*`, `azure.yaml` (one `services.<flowName>.project: ./FunctionApps/<Flow>` entry per stand-alone Function App) |
| `azure-workflow-tester` | Logic Apps only | `tests-mstest/<Flow>.Tests/` (MSTest + typed mocks, fixtures, `test-parameters.json`) |
| `azure-cicd-author` | All | `app/.github/workflows/deploy.yml`, `app/.github/workflows/pr-validate.yml` (one publish job per non-empty bucket) |
| `azure-reviewer` | All | `azure-review.md` (Well-Architected audit across every emitted tree) |

For Logic Apps Standard unit tests, the generated MSTest project uses a test-only `test-parameters.json` rather than the runtime `app/parameters.json`, because the Logic Apps unit-test host rejects reserved runtime parameter names such as `$connections`. For stateless workflows, the generated tests also rely on `Workflows.<FlowName>.OperationOptions = WithStatelessRunHistory` in `app/local.settings.json` and fall back to structural workflow assertions when the SDK cannot materialize a stateless response run.

---

## Stage 15 — Test and Deploy (Azure)

**Prompt:** `/test-azure`, then `/deploy-azure`
**Input:** Generated solution
**Output:** Test results, deployed resources

`/test-azure` runs the MSTest unit tests from `tests-mstest/`. `/deploy-azure` provisions infrastructure and deploys the solution using azd with OIDC federated credentials.

---

## Utility Prompts

| Prompt | Purpose |
|--------|---------|
| `/ir-diff` | Compare two versions of the IR |
| `/drift-check` | Verify artifacts haven't drifted from the IR |
| `/visualize` | Render flows as Mermaid diagrams |

---

## BizTalk Reverse-Engineering Path

For migrating existing BizTalk integrations, a separate entry point feeds into the same core pipeline:

```
BizTalk solution → /biztalk-inventory → specs/biztalk/biztalk-inventory.md
    → biztalk-spec-author → spec.md
    → biztalk-contract-extractor → contracts/
    → biztalk-ir-compiler → integration-ir.yaml
    → (continue from Stage 8 above)
```

**Prompt:** `/biztalk-reverse-engineer` runs the full chain automatically.
