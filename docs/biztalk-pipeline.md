# BizTalk Migration Pipeline

Step-by-step guide for reverse-engineering a BizTalk Server solution into a deployed integration using Spec2Integration.

The command surface uses the same role taxonomy as the greenfield path so users can tell which prompts advance work versus inspect or recover it:

- `Guided` prompts orchestrate multiple stages for you. Start with `/run-pipeline --mode biztalk` or `/biztalk-reverse-engineer`.
- `Manual` prompts advance one artifact-producing stage at a time. Use these when you want to inspect outputs between stages.
- `Reporting` prompts explain current state without advancing the pipeline. Use `/next` for the shortest answer and `/status` for the full table.
- `Recovery` prompts target a specific validation or repair loop after a block.
- `Advanced` prompts are optional utilities that are usually only relevant for specialist workflows.

---

## Prerequisites

- Claude Code (CLI, VS Code extension, or claude.ai/code) with this workspace open
- Optionally the **Spec2Integration VS Code extension** (`tools/vscode-extension/`), which drives this whole flow as a 3-step UX — **Specify Source → Analyse → Run Pipeline (per group) → Deploy** — and surfaces each catalogue group with a one-click **Migrate** action
- Access to the BizTalk solution folder (`.btproj`, `.odx`, `.btm`, `.xsd`, `.btp`, binding `.xml` files)
- For MSI extraction: Windows with `msiexec` and `expand` available
- For Azure deployment: Azure CLI, azd, .NET SDK

---

## Overview

The BizTalk pipeline reverse-engineers an existing BizTalk solution into the same IR used by the greenfield pipeline. Once the IR is produced, the remaining stages (model, review, plan, implement) are identical.

```
BizTalk Solution → /biztalk-inventory → specs/biztalk/biztalk-inventory.md + integration-catalogue.md
    (if MSIs present, the cracker runs first and writes specs/biztalk/_extracted/)
    → /biztalk-reverse-engineer [--group INT-NNN] → spec.md + contracts/ + integration-ir.yaml
    → /model → /review → /plan → /tasks → /implement-azure
```

> **Per-group migration (`--group INT-NNN`).** The `integration-catalogue.md` produced by inventory groups the solution into `INT-NNN` integration boundaries that migrate **independently**. Pass `--group INT-NNN` to `/biztalk-reverse-engineer` (or `/run-pipeline --mode biztalk`) to scope a run to **one** group — it lands in a group-named folder `specs/biztalk/NNN-<group-slug>/`, the agents honor the `Source group: INT-NNN` scope, and the IR records `source.group` + `source.groupName`. Run once per group to migrate a solution group-by-group, each becoming its own deployable integration. **Omit `--group`** to collapse the whole solution into one combined integration (legacy behavior).

> **Tip — one-shot run.** Use `/run-pipeline --mode biztalk --input <solution-folder> [--group INT-NNN]` to execute every stage below up through `/test-azure` in a single command. The orchestrator gates on `<folder>/status.json` between stages and stops at every human touchpoint (clarifications, BLOCKED flows, Sev-1/Sev-2 findings). Resume after a fix with `/run-pipeline --mode biztalk --folder <folder>`. Deployment is intentionally excluded — invoke `/deploy-azure` yourself when ready.

> **Navigation tip.** Advancing prompts should end by asking `What do you want to do next?` in chat. The prompt should explain the recommendation first, then offer a few fixed choices such as the recommended command, a guided or recovery alternative, and `Stop here`. Treat that question as the fastest path; use `/status <folder>` when you want the full stage table.

> **Quick orientation.** Use `/next <folder>` when you only want the single recommended follow-up command and the main blocking counters without the full status table.

> **Choosing a path.** For most BizTalk migrations, prefer the guided entry points. Use the manual stages below when you want artifact-by-artifact control after inventory or reverse engineering.

---

## Stage 1 — Inventory the BizTalk Solution

**Prompt:** `/biztalk-inventory`
**Agents:** `biztalk-msi-cracker` (conditional), `biztalk-inventory`
**Input:** Path to the BizTalk solution folder
**Output:** `specs/biztalk/_extracted/` (when MSIs present), `specs/biztalk/biztalk-inventory.md`, `specs/biztalk/integration-catalogue.md`

### 1a — MSI Crack (conditional)

If any `*.msi` files are present under the solution folder (excluding `.msi-extract/` and `_extracted/`), the `biztalk-msi-cracker` agent runs first. It performs an administrative install with `msiexec /a`, parses each MSI's `ApplicationDefinition.adf`, expands the embedded CABs, and reflects over every `BizTalkAssembly` DLL using `Mono.Cecil` (or `MetadataLoadContext` on .NET 8+) to recover the compiled artifacts that BizTalk embeds as managed resources:

| Embedded resource | Extracted to |
|---|---|
| `*.xsl` (compiled maps) | `_extracted/<msi>/maps/` |
| `*.xsd` (compiled schemas) | `_extracted/<msi>/schemas/native/` |
| `*.odx` (orchestration designer source) | `_extracted/<msi>/orchestrations/` |
| `*.btp` (pipeline graphs) | `_extracted/<msi>/pipelines/` |
| `BindingInfo.xml` | `_extracted/<msi>/bindings/` |
| BRE policies and vocabularies | `_extracted/<msi>/policies/` |
| Custom pipeline component DLLs | `_extracted/<msi>/components/` |
| Helper assemblies (plain .NET) | `_extracted/<msi>/helpers/` |

The agent emits `specs/biztalk/_extracted/_manifest.json` recording every artifact along with per-XSLT flags (`usesInlineScript`, `usesDatabaseLookup`, `extensionNamespaces`) and per-XSD flags (`hasFlatFileAnnotations`, `hasEdiAnnotations`, `rootElement`). Downstream agents read the manifest instead of re-reflecting.

> **Why this matters:** MSIs are production truth. Source trees often drift from what is actually deployed, and many BizTalk shops only retain the MSI. The cracker also recovers compiled XSLT for maps that have no `.btm` in the source tree (compiled-only delivery). Article V applies to maps whose `usesDatabaseLookup` is true — BizTalk `DatabaseLookup` functoids embed connection strings (often with `sa` credentials) into the compiled XSLT; the manifest flags these as `containsEmbeddedSecrets: true` and the IR compiler downgrades them to `migrationHint: manual`.

If no MSIs are present, this sub-stage is skipped silently.

### 1b — Inventory

The `biztalk-inventory` agent then catalogs every artifact in the solution: orchestrations (`.odx`), maps (`.btm`), schemas (`.xsd`), pipelines (`.btp`), binding files, and BRE policies. When `_extracted/_manifest.json` exists, the inventory trusts it for MSI-deployed artifacts (skipping its own `msiexec` pass) and inherits the per-artifact flags to refine `migrationHint`. Each artifact is:
- Classified by type
- Grouped by integration boundary (shared ports, schemas, or correlation sets)
- Assigned a migration complexity hint: `auto`, `local-function`, `azure-function`, or `manual`

**Example:**
```
/biztalk-inventory C:\BizTalk\OrderProcessing
```

> **Action required:** Review `specs/biztalk/biztalk-inventory.md` and `specs/biztalk/integration-catalogue.md` before proceeding. Pay special attention to `manual` complexity items — these require human implementation and will become `BLOCKED` flows in the IR. `/biztalk-inventory` is only the first step, not a standalone entry point — it ends by printing a prominent `Next: run /biztalk-reverse-engineer <folder>` call-to-action, which cracks the MSIs, authors the spec, extracts contracts, and compiles the IR in one pass.

---

## Stage 2 — Reverse-Engineer (Automated)

**Prompt:** `/biztalk-reverse-engineer [--group INT-NNN]`
**Agents:** `biztalk-msi-cracker` (conditional), `biztalk-inventory` (if not already run), `biztalk-spec-author`, `biztalk-contract-extractor`, `biztalk-ir-compiler`
**Input:** BizTalk solution folder (or existing `specs/biztalk/biztalk-inventory.md`)
**Output:** `specs/biztalk/NNN-<slug>/spec.md`, `contracts/`, `integration-ir.yaml`, `mappings/<Name>.md` (one STM document per mapping — `biztalk-ir-compiler` emits these from the IR's preserved-XSLT `mappings[]`, so stage 4 (Mappings STM) is satisfied on the brownfield path and `/review` raises no `STM_MISSING` findings)

**Folder naming & scope.** For a **whole-solution** run, `<slug>` derives from the BizTalk application name and the spec covers every group. For a **group-scoped** run (`--group INT-NNN`), `<slug>` derives from the catalogue group's name (e.g. `INT-002 "XmlMapping PaymentRegistration"` → `specs/biztalk/NNN-xml-mapping-payment-registration/`), `spec.md` covers only that group and records `- **Source group:** INT-NNN <Name>` in its front matter, and the IR's `source:` block carries `group: INT-NNN` + `groupName`. `biztalk-contract-extractor` and `biztalk-ir-compiler` read that scope and emit only the group's schemas / ports / flows / mappings. Re-run per group to migrate the solution group-by-group.

This single command orchestrates the full chain. It re-runs the cracker and inventory if their outputs are missing, then runs three reverse-engineering agents in sequence:

### 2a — Spec Author
Reads the inventory and BizTalk source artifacts, infers business requirements, actors, and user stories, and produces `spec.md`. Orchestration shape names and port declarations are used to derive FRs and NFRs.

### 2b — Contract Extractor
Converts BizTalk schemas and bindings into the standard `contracts/` folder:
- `.xsd` → JSON Schema files under `contracts/schemas/`
- Native `.xsd` (and flat-file/EDI schemas) preserved verbatim under `contracts/xsd/` for runtime XML validation and wire-format compatibility with external systems
- HTTP/SOAP bindings → `contracts/openapi.yaml`
- Queue/topic/MQ bindings → `contracts/asyncapi.yaml`
- Flat-file and EDI schemas → stub JSON Schemas with `x-biztalk-` annotations

When `_extracted/_manifest.json` is present, the extractor unifies MSI-extracted XSDs with source-tree XSDs and **prefers the MSI version** on conflict (deployed wire format wins; drift is logged to Open Issues).

> **Constitution Article I:** The IR cannot proceed without contracts. The reverse-engineering prompt gates on the presence of `contracts/openapi.yaml`, `contracts/asyncapi.yaml`, at least one file under `contracts/schemas/`, and at least one file under `contracts/xsd/`.

### 2c — IR Compiler
Maps every BizTalk construct to its EIP equivalent in the IR:
- Orchestrations → flows with EIP node graphs
- Maps → `mappings[]` entries with JSONata/XSLT expressions
- Ports → `channels[]` and `endpoints[]`
- BRE policies → inline decision nodes or `local-function` references
- Custom code → extracted to `artifacts/custom/` with `migrationHint` set

When `_extracted/_manifest.json` is present, the IR compiler uses its flags to drive `migrationHint`:
- `usesDatabaseLookup: true` (or `containsEmbeddedSecrets: true`) → `migrationHint: manual` (Article V — secrets baked into compiled XSLT cannot be auto-migrated).
- `usesInlineScript: true` → `migrationHint: local-function`; the inline `<ScriptBuffer>` C# is extracted to `artifacts/custom/<MapName>.cs`.
- Compiled-only maps (no `.btm` in source) → the extracted XSLT is referenced directly with `engine: xslt`, `migrationHint: auto`.

The agent prints a **Migration Readiness Summary** showing artifact counts (orchestrations, maps, schemas, native schemas, pipelines, BRE policies, binary DLLs), complexity distribution, IR statistics (channels, messages, mappings, flows), and any BLOCKED flows.

#### Required IR shape (migration-mode contract)

Every IR produced by `biztalk-ir-compiler` MUST satisfy these four minimums or `ir-validator` will fail:

1. **Metadata** \u2014 `metadata.scenario: migration` AND `metadata.sourcePlatform: biztalk`.
2. **Source block** \u2014 top-level `source: { platform: biztalk, artifactsRoot: <rel-path> }` (and `preservedRoot` when the original solution lives outside the repo).
3. **Messages** \u2014 every message backed by a BizTalk `.xsd` MUST set `nativeSchemaSource: { origin: preserved, path: <rel-path-under-artifactsRoot> }`. Use `schemaLanguage: none` for opaque-passthrough binary messages.
4. **Mappings** \u2014 every entry derived from a `.btm` / compiled XSLT MUST set:
   - `origin: preserved`,
   - at least one of `sourceArtifact.btm` or `sourceArtifact.xslt`,
   - `engine: xslt`,
   - `migrationHint: preserve` (the default for BizTalk maps),
   - a `transforms` map covering every target pack (typically `logic_apps_standard: passthrough`).

Authored mappings (greenfield enrichment glue added during reverse engineering) MUST set `origin: authored` and pick a non-`preserve` `migrationHint`.

**Example:**
```
/biztalk-reverse-engineer C:\BizTalk\OrderProcessing
```

---

## Stage 3 — Model the Domain

**Prompt:** `/model`
**Agent:** `domain-modeler`
**Input:** `spec.md`, `clarifications.md` (if any)
**Output:** `data-model.md`

Same as the greenfield pipeline. The spec produced by `biztalk-spec-author` is in the standard format, so the domain modeler works without modification.

> **Sign-off loop applies here too.** The BizTalk spec author typically leaves OQs for production endpoints, retention, partner authentication, and intent of inline `userCSharp` code. Run `/clarify <folder>` to get candidate answers + recommendations; flip `**Resolved:** true` and complete the Resolution log row in `clarifications.md` for each one you accept; re-run `/clarify` to fold the signed-off answers into `spec.md` (see the [greenfield pipeline](greenfield-pipeline.md#stage-3--clarify) for the full loop). `/model` will not run while any Sev-1 OQ is still open.

---

## Stage 4 — Review

**Prompt:** `/review`
**Agent:** `reviewer` (orchestrates `ir-validator`, `pii-flow-checker`, `stm-drift-checker`, `secret-scanner`)
**Input:** Everything in the integration folder
**Output:** `review-report.md`, `review-report.json`

Audits the reverse-engineered artifacts against the 9 constitutional articles. Common findings on BizTalk migrations:
- **Sev-1:** Missing retry/DLQ on channels derived from BizTalk ports (Article VI)
- **Sev-1:** PII fields on public channels without redaction (Article V)
- **Sev-2:** STM drift if mappings were manually adjusted after IR generation

> **Gate:** The planner will not produce `plan.md` while any Sev-1 violation is open.

---

## Stage 5 — Select Platform Pack

**Prompt:** `/platform azure`
**Output:** `.spec2integration/state.json` updated

Registers Azure as the active platform pack.

> **Shortcut.** If you do not need to pause between review, plan, and tasks, run `/prepare-for-implementation <folder> --platform azure` instead of stages 5 through 7 individually.

---

## Stage 6 — Plan

**Prompt:** `/plan`
**Agent:** `planner`
**Input:** `integration-ir.yaml`, all upstream artifacts
**Output:** `plan.md`, `research.md`

Checks all phase gates before producing a phased implementation plan. For BizTalk migrations, the plan includes:
- Phases for `auto` and `local-function` artifacts (generated by the platform pack)
- Phases for `azure-function` artifacts (require Azure Function sidecars)
- Guidance for `manual` artifacts (human implementation required)

---

## Stage 7 — Decompose Tasks

**Prompt:** `/tasks`
**Agent:** `task-decomposer`
**Input:** `plan.md`, `integration-ir.yaml`
**Output:** `tasks.md`

Breaks the plan into atomic, TDD-ordered tasks. BLOCKED flows from manual migration items appear as separate task groups flagged for human implementation.

---

## Stage 8 — Implement (Azure)

**Prompt:** `/implement-azure`
**Agents (orchestrated in this order, each skipped when its bucket is empty):** `azure-logic-apps-compiler`, `azure-functions-compiler`, `azure-data-factory-compiler`, `azure-local-functions-author`, `azure-connections-binder`, `azure-bicep-author`, `azure-workflow-tester`, `azure-cicd-author`, `azure-reviewer`
**Input:** `integration-ir.yaml`, `contracts/`, `tasks.md`
**Output:** Full Azure solution, with each IR flow routed by `flows[].implementation.host` (default `logic-app-standard`) into the matching output tree

Same agents and routing as the [greenfield pipeline](greenfield-pipeline.md#stage-14--implement-azure). BLOCKED flows are skipped — the compiler emits a comment noting they require manual implementation. After `azure-reviewer`, `secret-scanner` runs over every emitted directory because the IR is reverse-engineered (skipped for greenfield).

| Agent | Bucket | Output |
|-------|--------|--------|
| `azure-logic-apps-compiler` | `logic-app-standard` | `app/<Flow>/workflow.json`, `app/host.json`, `app/Artifacts/Maps/`, `app/Artifacts/Schemas/` |
| `azure-functions-compiler` | `function-app` | `FunctionApps/<Flow>/<Flow>.csproj` + `Program.cs`, `host.json`, `Functions/`, `Models/`, `Mappings/` |
| `azure-data-factory-compiler` | `data-factory` | `adf/pipelines/<Flow>.json`, `adf/datasets/`, `adf/linkedServices/`, `adf/triggers/`, optional `adf/dataflows/` |
| `azure-local-functions-author` | Logic Apps `InvokeFunction` targets | `Functions/<Project>.csproj` (in-proc WebJobs SDK), `Functions/<Name>.cs` per target |
| `azure-connections-binder` | Logic Apps only | `app/connections.json`, `app/parameters.json`, `app/appsettings.*.json`, `app/.vscode/` |
| `azure-bicep-author` | All | `infra/main.bicep`, `infra/modules/*`, `azure.yaml` |
| `azure-workflow-tester` | Logic Apps only | `tests-mstest/<Flow>.Tests/` (MSTest + typed mocks) |
| `azure-cicd-author` | All | `app/.github/workflows/deploy.yml`, `app/.github/workflows/pr-validate.yml` |
| `azure-reviewer` | All | `azure-review.md` |
| `secret-scanner` (brownfield only) | All emitted trees | `secret-scan-report.{md,json}` |

---

## Stage 9 — Test and Deploy (Azure)

**Prompt:** `/test-azure`, then `/deploy-azure`
**Input:** Generated solution
**Output:** Test results, deployed resources

`/test-azure` runs the MSTest unit tests. `/deploy-azure` provisions infrastructure and deploys using azd.

---

## Migration Complexity Reference

| Hint | Meaning | Pipeline Action |
|------|---------|-----------------|
| `auto` | Pure built-in constructs only | Fully generated by platform pack |
| `local-function` | Stateless inline C#, simple BRE, DB lookups | Generated with embedded expressions or local function calls |
| `azure-function` | External service calls, EDI/flat-file, cross-boundary orchestration | Requires Azure Function sidecar — implement before `/implement-azure` |
| `manual` | No-source DLLs, BAM/Suspend, COM, complex EDI agreements | BLOCKED in IR — human must implement separately |

---

## Differences from the Greenfield Pipeline

| Aspect | Greenfield | BizTalk Migration |
|--------|-----------|-------------------|
| Starting point | PRD (rough idea) | BizTalk solution folder |
| Spec authoring | Human writes PRD, agent refines | Agent infers from orchestrations and bindings |
| Contract design | Agent designs from spec + data model | Agent extracts from XSD schemas and binding files |
| IR authoring | Agent architects from EIP patterns | Agent compiles from BizTalk constructs |
| Mapping design | Agent designs from scratch | Agent extracts from `.btm` map files |
| BLOCKED flows | N/A | Flows with `manual` dependencies are marked BLOCKED |
| Custom code | N/A | Extracted to `artifacts/custom/` with migration hints |
| Stages 3+ onward | Identical | Identical (model, review, plan, tasks, implement, deploy) |
