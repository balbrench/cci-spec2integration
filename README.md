# Spec2Integration

A spec-driven integration pipeline for Claude Code. Converts a PRD into a fully deployed integration solution through a strict sequence of agents and slash commands. All 34 agents, 27 commands, and 34 skills live directly under [.claude/](.claude/), grouped by naming prefix — no plugin or marketplace registration required.

## Quick Start

1. Open this workspace in Claude Code (CLI, VS Code extension, or claude.ai/code).
2. Claude Code auto-loads everything under [.claude/](.claude/) — no install step.
3. Type `/` to see the available slash commands.
4. Start with `/draft-prd` to create a PRD, then follow the pipeline.

### Validation Tooling

Some pipeline validation stages depend on local Node-based CLI tools:

- `Spectral` lints OpenAPI and AsyncAPI contracts during `/contracts`.
- `ajv-cli` validates JSON Schemas during `/contracts` and validates the IR schema in later stages.

The repo prefers on-demand execution through `npx`, so these tools can be fetched automatically when needed if Node.js and `npm` are installed. Global install is optional:

```text
npx -y @stoplight/spectral-cli --version
npx -y ajv-cli@5 --version
```

If you prefer a one-time machine setup, install them globally instead:

```text
npm install -g @stoplight/spectral-cli
npm install -g ajv-cli
```

### One-shot orchestration

Run the entire pipeline (intake → tests, **excluding deployment**) with a single command:

```text
/run-pipeline --mode greenfield --input "Order intake from HTTP, validate, publish to Service Bus"
/run-pipeline --mode biztalk    --input C:\Projects\BizTalk-Combined --allow-sev2
/run-pipeline --mode biztalk    --input C:\Projects\BizTalk-Combined --group INT-002   # migrate ONE catalogue group
/run-pipeline --mode biztalk    --folder specs/<domain>/001-<slug>   # resume
```

For BizTalk, pass `--group INT-NNN` to migrate a **single** catalogue integration group into its own folder (`specs/biztalk/NNN-<group-slug>/`) — run once per group to migrate a solution group-by-group. Omit it to collapse the whole solution into one combined integration.

`/run-pipeline` chains the stage commands below, gates on `<folder>/status.json` between steps, and stops at every human touchpoint (open clarifications, Sev-1/Sev-2 findings, BLOCKED flows, failing tests). It deliberately never invokes `/deploy-<platform>` — run that yourself when you're ready.

Every advancing prompt should end with a short next-step question in chat. It should explain the recommendation first, then offer fixed choices such as running the recommended command, switching to guided mode or a recovery path, or stopping.

### Pipeline Runner UI

`tools/pipeline-runner/` is a standalone localhost tool that assembles start, resume, and recovery commands (and can run them headlessly). It is intentionally prompt-driven: it builds the commands; you run them in chat.

```
node tools/pipeline-runner/server.mjs   # then open the printed http://127.0.0.1 URL
```

> The IR graph and a live status view now live in the VS Code extension (below), not in a separately served web page.

### VS Code Extension (in-IDE)

For the same prompt-driven model without leaving the editor, the **Spec2Integration
Pipeline** extension is on the Visual Studio Marketplace:

[**Install Spec2Integration Pipeline →**](https://marketplace.visualstudio.com/items?itemName=BalbirSingh.spec2integration)
&nbsp;·&nbsp; or run `code --install-extension BalbirSingh.spec2integration`

<img src="https://raw.githubusercontent.com/balbrench/cci-spec2integration/main/tools/vscode-extension/media/screenshots/pipeline-tree.png" alt="Spec2Integration pipeline tree — integrations expanded into live pipeline stages with status pills" width="360" />

It's a native VS Code extension: an activity-bar **Pipeline** tree that shows every
integration's stages live from `status.json`, a **guided wizard** that walks you
through each command's options, and a one-click hand-off that deep-links the
assembled `/command …` into your Claude Code chat (clipboard fallback). It also hosts
the **IR visualizer** (interactive flow graph + live status/findings overlay) as a
bundled webview. It can also **scaffold a fresh greenfield or BizTalk-migration
workspace** (bundled agents/skills/commands) with no folder open.

To build from source instead: `cd tools/vscode-extension && npm install && npm run compile`,
then press **F5** — see [`tools/vscode-extension/README.md`](tools/vscode-extension/README.md).

## Pipeline

```
PRD → /specify → spec.md → /model → data-model.md → /contracts → contracts/
→ /map → mappings → /architect → integration-ir.yaml → /plan → plan.md
→ /tasks → tasks.md → /implement-azure → deployable artifacts
```

## Structure

```
CLAUDE.md                       # Project guide + constitution (loaded by Claude Code at start)
.claude/
├── settings.json               # Permissions + hooks
├── agents/                     # 34 agents (core, biztalk-*, azure-*)
│   └── ...                     #   prd-author, clarifier, integration-architect, target-architecture, …
│                               #   biztalk-msi-cracker, biztalk-inventory, biztalk-spec-author, …
│                               #   azure-logic-apps-compiler, azure-functions-compiler, …
├── commands/                   # 27 slash commands
│   └── ...                     #   /run-pipeline, /specify, /architect, /plan, /tasks, …
│                               #   /biztalk-inventory, /biztalk-reverse-engineer
│                               #   /implement-azure, /test-azure, /deploy-azure, /platform
└── skills/                     # 34 skills
    └── ...                     #   eip-patterns, ir-authoring, pipeline-status, no-stubs-code-generation, …
                                #   biztalk-decompilation, biztalk-msi-extraction, biztalk-to-azure-mapping
                                #   ais-platform, eip-to-azure-mapping, logic-app-patterns, azure-functions, …
schemas/                        # JSON Schema for IR validation (see schemas/CLAUDE.md)
templates/                      # Skeleton files used by agents (see templates/CLAUDE.md)
├── core/                       # Platform-neutral templates
├── azure/                      # Azure Logic Apps templates
│   └── reference-workflows/    #   Curated, verified workflow.json + connections.json fragments
├── biztalk/                    # BizTalk reverse-engineering templates
└── contracts/                  # OpenAPI/AsyncAPI skeletons
docs/                           # Architecture documentation
examples/                       # Reference implementations
src/pipeline/FlowTester/        # .NET 8 deterministic flow-test runner
scripts/                        # Helper scripts (status refresh, catalog build)
tests/fixtures/                 # Test fixture data
```

Naming is the only grouping. Unprefixed agents/skills are platform-neutral core; `biztalk-*` covers brownfield reverse engineering; `azure-*` covers the Azure target platform. Add a new platform by dropping `<plat>-*` files directly into the same folders — see [docs/platform-pack-guide.md](docs/platform-pack-guide.md).

## Agents

Agents are background workers invoked by slash commands via the `Agent` tool — they are not called directly. They follow a naming convention:

- **Unprefixed** = platform-neutral core (works with any target platform)
- **`azure-`** = Azure Integration Services platform pack
- **`biztalk-`** = BizTalk Server reverse-engineering pack

Each agent owns exactly one primary artifact (Article IX of the constitution).

### Core Agents (20 — platform-neutral)

These produce platform-independent artifacts (spec, data model, contracts, IR, mappings, plans, reviews). They never reference a specific runtime.

| Agent | Description | Primary Artifact |
|-------|-------------|------------------|
| `prd-author` | Takes a rough integration brief (a few sentences or bullet points) and turns it into a structured PRD ready for `/specify`. | `specs/PRD.md` |
| `requirements-analyst` | Reads the PRD and produces a rigorous spec — user stories, FRs (MUST/SHOULD), NFRs, in-scope and explicitly out-of-scope items. First gate of the pipeline. | `spec.md` |
| `clarifier` | Surfaces every open question (OQ-N) implied by the spec, proposes candidate answers with evidence and confidence, and records the chosen resolution. Required before `/model`. | `clarifications.md` |
| `domain-modeler` | Distills entities, value objects, identity fields, events, and invariants from the spec. Used by contract-designer and integration-architect. | `data-model.md` |
| `contract-designer` | Generates OpenAPI (sync), AsyncAPI (async), and JSON Schemas from the spec + data model. Satisfies Article I (contract-first). | `contracts/` |
| `contract-linter` | Lints OpenAPI/AsyncAPI with Spectral and validates JSON Schemas with `ajv`. Prefers `npx` auto-bootstrap and falls back to global installs when present; hard-blocks on lint errors. | `contract-lint-report.{md,json}` |
| `mapping-designer` | Produces the platform-neutral `mappings[]` block of the IR (JSONata by default) plus a human-readable Source-to-Target Mapping (STM) document per mapping. Satisfies Article II-a. | IR `mappings:` + `mappings/<Name>.md` |
| `mapping-tester` | Evaluates each mapping's test fixtures against its expression and reports pass/fail. Gate in `/plan`. | `mapping-test-report.{md,json}` |
| `integration-architect` | Synthesises the vendor-neutral, EIP-aligned `integration-ir.yaml` from spec + data model + contracts + mappings. Validates against `schemas/integration-ir.schema.json`. | `integration-ir.yaml` |
| `ir-validator` | Structural and cross-reference integrity checks on the IR (channel/message refs, mapping refs, identity keys). Hard gate in `/review`. | `ir-validation-report.{md,json}` |
| `domain-architect` | Reads all IRs in a workspace and produces the business-domain artifact that groups integrations, declares canonical domain events, and sets domain-wide policy. | `domain.yaml` |
| `target-architecture` | Authors the cross-service Azure target architecture document for an integration (or domain spanning multiple integrations) — service mapping, security architecture, networking, naming/tagging, RBAC, and provisioning order. Sits between `integration-architect` (IR) and `azure-bicep-author` (per-integration Bicep). | `target-architecture.md` |
| `planner` | Enforces the constitution's phase gates and produces the implementation plan + research notes. Refuses to proceed while any Sev-1 violation is open. | `plan.md`, `research.md` |
| `task-decomposer` | Turns the plan into an atomic, TDD-ordered, dependency-graphed task list with `[P]` tags for parallelisable work. | `tasks.md` |
| `reviewer` | Audits every artifact in the integration folder against all 9 constitutional articles and aggregates findings from `ir-validator`, `pii-flow-checker`, `stm-drift-checker`, `secret-scanner`, and `spec-coverage-checker`. | `review-report.{md,json}` |
| `spec-coverage-checker` | Verifies every MUST/SHOULD requirement in `spec.md` is satisfied by an IR construct, and that every IR construct traces back to a requirement. | `traceability-matrix.md`, `spec-coverage-report.{md,json}` |
| `flow-tester` | Runs `flows[].tests[]` through an in-process deterministic interpreter (JSONata for mappings) and compares emitted messages against declared expectations. | `flow-test-report.{md,json}` |
| `pii-flow-checker` | Walks the IR to confirm PII fields are never emitted through a public-classification channel without redaction (hash/mask/drop). Enforces Article V(b). | `pii-flow-report.{md,json}` |
| `stm-drift-checker` | Regenerates each `mappings/<Name>.md` STM document from the IR and diffs against the committed file. Any diff is a Sev-2 STM_DRIFT finding. | STM drift findings |
| `secret-scanner` | Scans a directory tree for leaked secrets (API keys, connection strings, certificates) using `trufflehog` or `gitleaks`. Any finding is Sev-1. **Auto-invoked only for reverse-engineered integrations** (BizTalk migrations) where pre-existing artifacts may carry inline credentials; skipped for greenfield because Article V + the reviewer audits already enforce no-inline-secrets on generated code. Can still be run manually against any folder. | secret scan findings |

### Azure Pack Agents (9)

Consume `integration-ir.yaml` and `contracts/` to produce a deployable Azure solution. They never read the PRD, spec, or data-model (Article II). Each flow is routed by `flows[].implementation.host` to one of three host types: Logic Apps Standard (default), Function App, or Data Factory.

| Agent | Description | Primary Artifact |
|-------|-------------|------------------|
| `azure-logic-apps-compiler` | Compiles each IR flow whose host is `logic-app-standard` to a `workflow.json`, lifts XSLT maps and XSD schemas into `app/Artifacts/`, and selects the right service-provider connector per channel. Fails closed if the IR refers to mappings or schemas it cannot resolve. | `app/<FlowName>/workflow.json`, `app/Artifacts/Maps/`, `app/Artifacts/Schemas/` |
| `azure-functions-compiler` | Compiles each IR flow whose host is `function-app` into a stand-alone .NET 8 isolated-worker Azure Function App project — sibling to the Logic Apps project, deployed independently. One project per flow, one trigger function per flow. Skipped when no flow routes to `function-app`. | `FunctionApps/<FlowName>/*.csproj` + `*.cs` |
| `azure-data-factory-compiler` | Compiles each IR flow whose host is `data-factory` into an Azure Data Factory artifact tree (pipelines, datasets, linked services, triggers, optional data flows). Sibling to `app/` and `FunctionApps/`; deployed via the factory module in `infra/`. Skipped when no flow routes to `data-factory`. | `adf/pipelines/`, `adf/datasets/`, `adf/linkedServices/`, `adf/triggers/` |
| `azure-local-functions-author` | Emits the .NET 8 in-process WebJobs SDK project (`Functions/`) that backs every `InvokeFunction` action in Logic Apps Standard workflows — one C# class per local-function dependency declared in the IR. Not the same as `azure-functions-compiler` (which emits stand-alone Function Apps). | `Functions/*.csproj` + `*.cs` |
| `azure-connections-binder` | Generates `connections.json`, `parameters.json`, `appsettings.<env>.json`, `local.settings.json`, `.vscode/`, and managed-identity role assignment snippets. All bindings use system- or user-assigned MI (Article V(a)). Only runs when the Logic Apps bucket is non-empty. | `app/connections.json`, `app/parameters.json`, `app/appsettings.*.json`, `app/local.settings.json`, `app/identity-role-assignments.json` |
| `azure-bicep-author` | Writes the Bicep infrastructure (Logic App Standard WS1 plan, Service Bus + DLQs, Key Vault, Storage, App Insights, Log Analytics, managed identity, Function App, Data Factory) plus `azure.yaml` for `azd`. | `infra/main.bicep` + modules, `azure.yaml` |
| `azure-cicd-author` | Writes a GitHub Actions pipeline (lint, unit test, deploy via `azd`) with one publish job per non-empty bucket (Logic App, each Function App, Data Factory artifact import). Output path is non-negotiable: `<integration-folder>/app/.github/workflows/`. | `app/.github/workflows/deploy.yml`, `pr-validate.yml` |
| `azure-workflow-tester` | Generates MSTest unit-test scaffolds for each Logic Apps Standard flow using the official Logic Apps Standard unit-testing SDK, with typed mock classes per action. Only runs when the Logic Apps bucket is non-empty. | `tests-mstest/<FlowName>Tests/` |
| `azure-reviewer` | Audits every emitted artifact tree (`app/`, `Functions/`, `FunctionApps/`, `adf/`, `infra/`, `tests-mstest/`) against the Well-Architected Framework and Logic Apps Standard best practices. | `azure-review.md` |

### BizTalk Pack Agents (5)

Reverse-engineer a BizTalk Server solution into the pipeline's format. Each one feeds the next.

| Agent | Description | Primary Artifact |
|-------|-------------|------------------|
| `biztalk-msi-cracker` | Cracks open BizTalk application MSIs (BTSTask `ExportApp` output) to recover compiled artifacts: XSLT from map DLLs, XSDs from schema DLLs, ODX from orchestration DLLs, plus pipelines, custom pipeline components, helper assemblies, bindings, and BRE policies. Skipped when no `.msi` files are present. | `_extracted/` + `_manifest.json` |
| `biztalk-inventory` | Catalogues every artifact in the BizTalk source — orchestrations, maps, schemas, pipelines, binding files, BRE policies — groups them by integration boundary, and assigns a migration complexity score per artifact. | `biztalk-inventory.md`, `integration-catalogue.md` |
| `biztalk-spec-author` | Reads the inventory and the BizTalk artifacts it catalogues, infers business requirements / actors / user stories / FRs / NFRs, and writes the spec. The reverse-engineering equivalent of `requirements-analyst`. | `spec.md` |
| `biztalk-contract-extractor` | Generates `contracts/schemas/` (JSON Schema from XSD), `contracts/openapi.yaml` (from HTTP/SOAP bindings), and `contracts/asyncapi.yaml` (from queue/topic bindings). Satisfies Article I. | `contracts/` |
| `biztalk-ir-compiler` | Maps every BizTalk construct to its IR equivalent using EIP patterns and produces the IR plus extracted custom-code artifacts. Sets `migrationHint` on every custom artifact and a top-level `source: { platform: biztalk, ... }` provenance block. | `integration-ir.yaml`, `artifacts/custom/` |

## Slash commands

Type `/` in Claude Code to invoke. Each command enforces its prerequisites and, where applicable, refreshes `<integration-folder>/status.json` as its final step.

> A `PostToolUse` hook (`scripts/refresh-status.ps1`, wired in `.claude/settings.json`) also rebuilds `status.json` after any edit inside an integration folder and computes **mtime-based staleness** — so editing an upstream artifact (e.g. `spec.md` after the IR exists) automatically flips its downstream stages to `stale` and repoints `next` at the rebuild, surfaced on the next `/next` or `/status` without a manual probe. Remove the `hooks` block from `.claude/settings.json` to opt out.

### Guided Entry Points

Start here unless you have a reason not to.

| Prompt | Description |
|--------|-------------|
| `/run-pipeline` | End-to-end orchestrator from intake through tests, stopping before deployment. Best default for new users. |
| `/prepare-for-implementation` | Shorter orchestrator for the pre-implementation slice: `/platform` → `/review` → `/plan` → `/tasks`. Use this when the IR already exists and you want a lighter manual path. |
| `/next` | Show only the next recommended slash command from `<integration-folder>/status.json`, plus the key blocking counts. Fastest orientation command. |
| `/status` | Show the full stage table, current blockers, and next-step recommendation for an integration folder. |
| `/use` | Show or set the **active integration** — the folder commands default to when you omit the path. `/use <folder>` pins it (stored as `activeIntegration` in `.spec2integration/state.json`), `/use` shows it, `/use --clear` unsets it. Any command run with an explicit folder also pins it. |

### Manual Build Path

Use these when you want to pause and inspect artifacts between stages.

| Prompt | Description |
|--------|-------------|
| `/draft-prd` | Turn a free-form integration brief into a structured PRD ready for `/specify`. **Re-run it to enrich the existing PRD** — `prd-author` merges your new input into `specs/PRD.md` and preserves prior content, so you can build it up over several calls; pass `--fresh` to rewrite from scratch. |
| `/specify` | Produce a rigorous `spec.md` from the PRD. First mandatory gate; everything downstream depends on it. **Re-run it to update the spec in place** — `/specify "add an NFR …"` folds a direct instruction in, and `/specify` (no arg) reconciles against a changed PRD; editing `specs/PRD.md` also flips the Spec stage to `stale`. `--fresh` forces a new integration. Invokes `requirements-analyst`. |
| `/clarify` | Surface every open question implied by the spec, propose candidate answers with evidence, and capture resolutions in `clarifications.md`. Required before `/model`. Invokes `clarifier`. |
| `/model` | Produce `data-model.md` (entities, events, identity fields, invariants) from the spec + clarifications. Invokes `domain-modeler`. |
| `/contracts` | Generate `contracts/openapi.yaml`, `contracts/asyncapi.yaml`, and the referenced JSON Schemas. Auto-runs `contract-linter` as the closing gate. Invokes `contract-designer` then `contract-linter`. |
| `/map` | Produce the platform-neutral `mappings[]` block and one STM document per mapping. Article II-a satisfaction. Invokes `mapping-designer`. |
| `/architect` | Synthesise `integration-ir.yaml` from spec + data model + contracts + mappings, then validate against `schemas/integration-ir.schema.json`. Invokes `integration-architect`. |
| `/plan` | Produce `plan.md` and `research.md`. Enforces all 8 constitutional phase gates and blocks while any Sev-1 is open. Invokes `planner`. |
| `/tasks` | Produce `tasks.md` — atomic, TDD-ordered, dependency-graphed tasks with `[P]` parallelisation tags. Invokes `task-decomposer`. |

### Reporting And Diagnostics

These help you understand state, drift, and structure without advancing the pipeline.

| Prompt | Description |
|--------|-------------|
| `/visualize` | Render the IR flows as Mermaid sequence/flow diagrams for the IR visualiser. Read-only. |
| `/ir-diff` | Compare two `integration-ir.yaml` versions and summarise structural changes. Read-only. |
| `/drift-check` | Verify generated artifacts have not drifted from the IR. Read-only in report-only mode. |
| `/domain` | Group multiple integrations into a single `domain.yaml` (canonical events, shared policy). Optional and usually only relevant for multi-integration work. |

### Recovery And Validation

Use these when you need targeted control over validation gates or recovery after a block.

| Prompt | Description |
|--------|-------------|
| `/platform` | Select the active platform pack (`azure`, `mulesoft`, …) and record it in `.spec2integration/state.json`. |
| `/review` | Audit every artifact in the integration folder against the constitution. `ir-validator` runs first as a fail-fast pre-gate; the independent validators (`pii-flow-checker`, `stm-drift-checker`, `spec-coverage-checker`, plus `secret-scanner` when the IR is reverse-engineered) then run **in parallel** before `reviewer` aggregates their findings. `secret-scanner` is skipped for greenfield. |
| `/test-mappings` | Execute every mapping's test fixtures and report pass/fail per rule. Invokes `mapping-tester`. |
| `/test-flows` | Execute every flow's `tests[]` block through the in-process interpreter. Invokes `flow-tester`. |

### Azure Platform Pack (3)

Run only after `/plan`, `/tasks`, and `/platform azure` succeed.

| Prompt | Description |
|--------|-------------|
| `/implement-azure` | Manual platform step. Buckets every IR flow by `implementation.host` (`logic-app-standard` / `function-app` / `data-factory`), then compiles each bucket into its own sibling output tree: `<integration-folder>/app/` (Logic Apps Standard), `FunctionApps/<FlowName>/` (stand-alone Function Apps), `adf/` (Data Factory), plus `Functions/` (in-process WebJobs DLLs for Logic Apps `InvokeFunction` targets), `infra/` (Bicep), `tests-mstest/`, `azure.yaml`, and a `<slug>.code-workspace` at the integration root. Orchestrates `azure-logic-apps-compiler` → `azure-functions-compiler` → `azure-data-factory-compiler` → `azure-local-functions-author` → `azure-connections-binder` → `azure-bicep-author` → `azure-workflow-tester` → `azure-cicd-author` → `azure-reviewer`. Each compiler is skipped when its bucket is empty. For BizTalk-sourced IRs only, also runs `secret-scanner` after `azure-reviewer` (skipped for greenfield). |
| `/test-azure` | Recovery and validation step. Run runtime validation (`func start`) plus the MSTest unit suite plus the local end-to-end test matrix. Produces `TEST-REPORT.md`. |
| `/deploy-azure` | Manual release step. Provision the Bicep infrastructure with `azd up`, deploy the workflow content, validate post-deploy health, and update `status.json`. |

### BizTalk Reverse Engineering (2)

| Prompt | Description |
|--------|-------------|
| `/biztalk-inventory` | Manual brownfield intake step. Catalogue the BizTalk source tree (auto-runs `biztalk-msi-cracker` first if `.msi` files are present), group artifacts into integration boundaries, and assign migration complexity scores. Invokes `biztalk-inventory`. |
| `/biztalk-reverse-engineer` | Guided brownfield entry point. Runs `biztalk-spec-author` → `biztalk-contract-extractor` → `biztalk-ir-compiler`, producing `specs/biztalk/NNN-<slug>/` ready for `/clarify` and the standard forward pipeline. Pass `--group INT-NNN` to scope the run to a **single** catalogue group (folder named from the group; the agents honor the `Source group:` scope and record `source.group` in the IR); omit it to migrate the whole solution into one combined integration. |

## Adding a New Platform

To add support for a new target platform (e.g., MuleSoft, AWS Step Functions):

1. Add platform-prefixed agents directly to [.claude/agents/](.claude/agents/): `mulesoft-compiler.md`, `mulesoft-connections-binder.md`, `mulesoft-infra-author.md`, `mulesoft-workflow-tester.md`, `mulesoft-cicd-author.md`, `mulesoft-reviewer.md`.
2. Add platform commands to [.claude/commands/](.claude/commands/): `implement-mulesoft.md`, `test-mulesoft.md`, `deploy-mulesoft.md`.
3. Add an EIP mapping skill to [.claude/skills/](.claude/skills/): `eip-to-mulesoft-mapping/SKILL.md`. This is the core intellectual work — see the existing `eip-to-azure-mapping` skill for the schema.
4. Add native templates under `templates/<platform>/`.
5. Core agents and the IR remain untouched.

See [docs/platform-pack-guide.md](docs/platform-pack-guide.md) for the full walkthrough.

## Documentation

| Guide | Description |
|-------|-------------|
| [Greenfield Pipeline](docs/greenfield-pipeline.md) | Step-by-step guide through all 15 greenfield pipeline stages |
| [BizTalk Migration Pipeline](docs/biztalk-pipeline.md) | Step-by-step guide for reverse-engineering a BizTalk solution to Azure |
| [Agent Reference](docs/agent-reference.md) | Detailed reference for all 34 agents (20 core + 5 BizTalk + 9 Azure) |
| [Architecture Review — Skills/Agents/Commands](docs/architecture-review-skills-agents.md) | Design review of how work is split across the three Claude Code primitives |
| [IR Authoring Guide](docs/ir-authoring-guide.md) | Practical guide for reading and writing integration-ir.yaml |
| [IR Specification](docs/ir-spec.md) | Formal spec for IR kinds, channels, and messaging semantics |
| [Platform Pack Guide](docs/platform-pack-guide.md) | How to create a new platform pack |
| [Authoring Packs](docs/authoring-packs.md) | Contract obligations and scaffolding steps for a new platform pack |
| [Architecture](docs/architecture.md) | Hexagonal two-layer architecture and artifact hierarchy |

## Constitution

The pipeline enforces non-negotiable articles (see [CLAUDE.md](CLAUDE.md)):

1. Contract-first
2. IR-first
   - II-a. Mappings are platform-neutral (JSONata by default; portable engines only)
3. Idempotency
4. Observability
5. Least-privilege identity & data handling (identity, classification, PII redaction, retention)
6. Retries and DLQ
7. Tests before implementation
8. No hidden state
9. One agent, one artifact

Reverse-engineered IRs (e.g. from BizTalk) must declare a top-level `source:` block so platform packs can apply source-aware fast paths and fail-closed on missing native artifacts (XSDs, XSLTs).

## License

See [LICENSE](LICENSE).
