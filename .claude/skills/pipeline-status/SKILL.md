---
name: pipeline-status
description: How to refresh `<folder>/status.json` — the derived per-integration status file consumed by the IR visualizer's Migration Status panel. Every agent that produces or modifies an artifact under `specs/**/NNN-<slug>/` MUST update its own stage(s) in this file as its final step.
---

# pipeline-status skill

`status.json` is derived state. Agents own their stage rows — each agent updates only the stages it produces, merging into the existing file rather than rebuilding from scratch.

## Who updates status.json

**Agents** are the primary owners. Each agent knows exactly what it produced; it updates only its own stage rows. Slash commands no longer own the refresh — they simply invoke agents and gate on the result.

**When to update:** as the very last step before returning, after all artifacts are confirmed written to disk.

**How to update (merge pattern):**
1. Read the existing `<folder>/status.json`. If the file does not exist, start from an empty object with the standard schema.
2. Update only the `stages[]` rows this agent owns — set `status`, `summary`, and any counts. Leave all other rows unchanged.
   - **`summary` is ONE short line — a status caption, not a run log. Hard cap ≈200 characters; plain ASCII.** State only the outcome + the load-bearing counts (e.g. `"PASS: 0 Sev-1, 1 Sev-2 (SCANNER_MISSING overridden)"`, `"7 workflows + Functions + infra + CI/CD; azure-review PASS; 123 artifacts"`). This field is rendered verbatim in the IR visualizer's Migration Status panel — a paragraph makes the panel unreadable.
   - **REPLACE your row's `summary`, never append to it.** Do not concatenate your step-by-step narrative, rationale, file lists, or — especially on a multi-agent stage like 10 (Implement) — the *previous* agent's summary. When several agents own one stage, the last writer rewrites it as a single combined one-liner; if you need to preserve per-agent provenance, put it in your chat response or the stage's report file, NOT in `summary`. (A 17 KB stage-10 summary that swallowed five agents' histories is exactly the failure this rule prevents.)
3. Recalculate `counts` fields for the fields this agent affects (e.g. `sev1`/`sev2`/`sev3` after a review, `blockedFlows` after IR compilation). Leave counts you don't own unchanged.
4. Update `generatedAt` to the current UTC ISO-8601 timestamp.
5. Set `refreshedBy` to the agent's name (e.g. `"reviewer"`, `"planner"`, `"azure-logic-apps-compiler"`).
6. Recalculate `next` — find the earliest stage that is not `done` and set the appropriate command.
7. Preserve `artifactHashes` and `lastImplement` keys if present — never overwrite them.
8. Write the merged result back.

**Read-only agents** (`ir-validator` when run standalone, `spec-coverage-checker`, `stm-drift-checker`, `pii-flow-checker`, `secret-scanner`) still update their specific sub-stages (5a, 5b, 5c, 5d) — they produce report files that have a definitive pass/fail verdict.

It does **not** apply to read-only prompts (`/ir-diff`, `/visualize`, `/drift-check` when run in report-only mode) or utility agents that don't produce integration artifacts (`prd-author`, `domain-architect`, `target-architecture`).

## Stage ownership map

| Agent | Stage id(s) | Status value when done |
|---|---|---|
| `biztalk-inventory` | `0a`, `0b` | `done` (both `biztalk-inventory.md` and `integration-catalogue.md` written) |
| `biztalk-spec-author`, `requirements-analyst` | `1` | `done` |
| `clarifier` | `1a` | `done` (openClarifications=0) or `blocked` |
| `domain-modeler` | `2` | `done` |
| `biztalk-contract-extractor`, `contract-designer` | `3` | `done` |
| `contract-linter` | `3a` | `done` (PASS) or `blocked` (FAIL) |
| `mapping-designer` | `4` | `done` (M/N STMs) |
| `biztalk-ir-compiler`, `integration-architect` | `5` | `done` (flows/channels/mappings counts, BLOCKED count) |
| `ir-validator` | `5a` | `done` (PASS) or `blocked` (FAIL) |
| `stm-drift-checker` | `5b` | `done` or `blocked` |
| `secret-scanner` | `5c` | `done` or `blocked` |
| `pii-flow-checker` | `5d` | `done` or `blocked` |
| `reviewer` | `5e` | `done` (sev1=0) or `blocked` (sev1>0) |
| `mapping-tester` | `6` | `done` (failed=0) or `blocked` |
| `flow-tester` | `6a` | `done` (failed=0) or `blocked` |
| `planner` | `8` | `done` or `blocked` (plan-blocked.md produced) |
| `task-decomposer` | `9` | `done` |
| `azure-logic-apps-compiler`, `azure-functions-compiler`, `azure-data-factory-compiler`, `azure-connections-binder`, `azure-bicep-author`, `azure-local-functions-author`, `azure-cicd-author` | `10` | `done` (M/N flows) or `blocked` |
| `azure-workflow-tester` | `11` | `done` |

## Resolving the integration folder

Commands that act on a single integration resolve the target folder with this precedence — **first match wins**:

1. **Explicit argument** — the folder path passed to the command.
2. **Active integration** — `activeIntegration` in `.spec2integration/state.json`, when it is set and the folder still exists.
3. **Sole candidate** — the only `specs/*/*/` integration folder, when exactly one exists.
4. **Ask** — when more than one candidate exists, list them most-recent-first (with each folder's last-modified time) and ask the user to choose. Never silently pick by mtime.
5. **None** — otherwise stop and tell the user to run `/specify` (greenfield) or `/biztalk-reverse-engineer` (BizTalk) first.

### Active integration (`activeIntegration`)

`activeIntegration` is a convenience pointer in `.spec2integration/state.json` (a relative folder path) so you can run `/map`, `/review`, `/plan`, … without re-typing the path every time. It is **not** pipeline state that affects generated artifacts — changing or clearing it never alters any file, so it does not violate Article VIII.

- **A command that writes** (one that produces or audits artifacts — it has `Edit`/`Write` in its tools) **pins** the folder it resolved into `activeIntegration` whenever it resolved via rule 1, 3, or 4 above. Writing the same value again is harmless; resolving via rule 2 needs no re-pin.
- **Read-only reporting commands** (`/next`, `/status`, `/ir-diff`, `/visualize`, `/drift-check`) **consult** `activeIntegration` as a default but never write it.
- **`/use <folder>`** sets it explicitly; **`/use`** (no argument) shows it; **`/use --clear`** unsets it.
- The background `refresh-status.ps1` hook **never** changes `activeIntegration` — only an explicit user action (running a command with a folder argument, choosing in the rule-4 prompt, or `/use`) does.

When pinning, preserve every other field in `state.json` and its existing encoding; only add/update the `activeIntegration` key.

## Stage table

Probe each artifact. Record `done | missing | blocked | covered` and a short `summary` string.

| id  | name              | done check                                                                                                     |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| 0a  | Inventory         | `specs/biztalk/biztalk-inventory.md` exists (BizTalk path) — for greenfield, this stage is implicitly `done`. |
| 0b  | Catalogue         | `specs/biztalk/integration-catalogue.md` exists (BizTalk path) — defines the `INT-NNN` boundaries every downstream agent consumes; for greenfield, this stage is implicitly `done`. |
| 1   | Spec              | `<folder>/spec.md` exists.                                                                                     |
| 1a  | Clarifications    | `<folder>/clarifications.md` exists with at least one OQ. Status is `done` if file exists; the summary should report `<closed>/<total>` and remaining open count. |
| 2   | Data model        | `<folder>/data-model.md` exists.                                                                               |
| 3   | Contracts         | `<folder>/contracts/openapi.yaml` AND `contracts/asyncapi.yaml` AND at least one file under `contracts/schemas/`. |
| 3a  | Contracts lint    | `<folder>/contract-lint-report.json` exists with verdict `PASS`.                                              |
| 4   | Mappings (STM)    | one `<folder>/mappings/<Name>.md` per `mappings[].name` in IR.                                                |
| 5   | IR                | `<folder>/integration-ir.yaml` exists.                                                                         |
| 5a  | IR validation     | `<folder>/ir-validation-report.json` exists.                                                                   |
| 5b  | STM drift         | `<folder>/stm-drift-report.json` exists. If `/review` was the producer, this stage may be marked `covered`.   |
| 5c  | Secret scan       | `<folder>/secret-scan-report.json` exists, OR `integration-ir.yaml` has no top-level `source:` block (greenfield → `done` with summary `not applicable (greenfield)`). May be `covered` by `/review` when the scanner runs (BizTalk path).         |
| 5d  | PII flow          | `<folder>/pii-flow-report.json` exists. May be `covered` by `/review`.                                        |
| 5e  | Review            | `<folder>/review-report.json` exists.                                                                          |
| 6   | Mapping tests     | `<folder>/mapping-test-report.json` exists with `failed=0`.                                                   |
| 6a  | Flow tests        | `<folder>/flow-test-report.json` exists with `failed=0`.                                                      |
| 7   | Platform pack     | `.spec2integration/state.json` exists with non-null `activePlatform`. **Always re-probe from `state.json` on every refresh — never preserve a prior row value.** This stage is a pure function of `state.json` and is owned by no artifact-producing agent, so the per-agent merge model (which preserves rows an agent doesn't own) would otherwise leave a stale `missing` placeholder forever when a run reuses an already-active pack without re-running `/platform`. Summary: `<activePlatform>` when set, else `no active platform`. |
| 8   | Plan              | `<folder>/plan.md` exists (not `plan-blocked.md`).                                                             |
| 9   | Tasks             | `<folder>/tasks.md` exists.                                                                                    |
| 10  | Implement         | per platform — for `azure`: one `<folder>/app/<flow>/workflow.json` per non-BLOCKED flow (flow folders sit at the LA project root, NOT under `src/`).                       |
| 11  | Tests             | per platform — for `azure`: `<folder>/tests-mstest/**/*.csproj` exists (the MSTest project; `<folder>/app/tests/` is reserved for designer JSON fixtures, not csproj). **Execution-aware:** when `<folder>/tests-mstest/test-results.json` exists (written by `/test-azure`), the summary reports `MSTest executed: N/total passed` and the stage is `blocked` if `failed > 0`; generation alone (csproj present, no results) is still `done` but the summary says `generated; not yet executed` so the tree and `/status` agree on whether tests have actually run. |
| 12  | Deploy            | per platform — for `azure`: `<folder>/azure.yaml` AND `<folder>/.azure/` both exist (`.azure/` is created by `azd up`).                                                       |

`covered` is used **only** when one prompt has explicitly subsumed another's report (e.g. `/review` runs the secret-scanner / pii-flow-checker / stm-drift-checker in-process and aggregates their findings into `review-report.json`).

`stale` is used when a stage's artifact exists but at least one of its upstream sources has a newer mtime — see "Staleness" below.

## Staleness (mtime-based)

A stage is `stale` when its primary artifact exists on disk but at least one upstream source has a more recent modification time. Staleness is what lets `/status` and `/next` answer "I edited spec.md after the IR was generated — what's broken?" without the user having to remember.

Dependency map (downstream stage → upstream sources whose mtimes must be older):

| Downstream stage | Upstream sources (any newer → stale) |
| --- | --- |
| 1  Spec                  | `specs/PRD.md` (**repo-root path, not folder-relative**; greenfield only — a BizTalk spec derives from `specs/biztalk/biztalk-inventory.md` and `specs/biztalk/integration-catalogue.md`, not a PRD, so skip this edge when the IR has a top-level `source:` block). Re-run `/specify` to fold the PRD change into the existing spec in place. |
| 2  Data model            | `spec.md` |
| 3  Contracts             | `spec.md`, `data-model.md` |
| 3a Contracts lint        | `contracts/openapi.yaml`, `contracts/asyncapi.yaml`, files under `contracts/schemas/` |
| 4  Mappings (STM)        | `spec.md`, `data-model.md`, `contracts/**` |
| 5  IR                    | `spec.md`, `data-model.md`, `contracts/**`, `mappings/**` |
| 5a IR validation         | `integration-ir.yaml` |
| 5b STM drift             | `integration-ir.yaml`, `mappings/**` |
| 5c Secret scan           | `integration-ir.yaml` |
| 5d PII flow              | `integration-ir.yaml` |
| 5e Review                | `spec.md`, `data-model.md`, `contracts/**`, `mappings/**`, `integration-ir.yaml` |
| 6  Mapping tests         | `integration-ir.yaml`, `mappings/**` |
| 6a Flow tests            | `integration-ir.yaml` |
| 8  Plan                  | `spec.md`, `data-model.md`, `contracts/**`, `mappings/**`, `integration-ir.yaml` |
| 9  Tasks                 | `plan.md`, `integration-ir.yaml` |
| 10 Implement             | `tasks.md`, `integration-ir.yaml` |
| 11 Tests                 | `tasks.md`, `integration-ir.yaml` |

Use `stat -c %Y <file>` (or equivalent) to compute mtimes. For a directory source (`contracts/`, `mappings/`), use the newest mtime found among its files.

When a stage is detected stale, set its `status` to `stale` (do not downgrade to `missing`) and populate a top-level `staleness` array in `status.json` listing every stale stage with the upstream that triggered it. The most-upstream stale stage drives `next` (see precedence).

### Graceful degradation when `Bash` is not in the prompt's tool list

Most pipeline commands (`/specify`, `/clarify`, `/model`, `/contracts`, `/map`, `/architect`, `/review`, `/plan`, `/tasks`) do not include `Bash` in their `allowed-tools` and therefore cannot call `stat`. When refreshing `status.json` from one of these commands:

1. Leave the `staleness` array empty (`[]`) and `counts.staleStages` as `0`.
2. Do not promote any stage to `stale` — keep stage statuses as `done` / `missing` / `blocked` / `covered`.
3. Add `"staleness_probed": false` to the JSON so `/next` and the visualizer know to ask for a re-probe.
4. In the chat follow-up, append one extra line: `Note: staleness was not probed in this refresh. Run /status <folder> to check whether earlier artifacts were edited after later ones.`

`/status` is the canonical staleness probe — it has `Bash` in its tool list and always runs the mtime comparison. Users who edit a source artifact mid-flow should run `/status` (or `/next`, which reads the same file) to surface the resulting staleness.

## Next-step precedence

The first stale-or-unmet stage wins. Staleness takes priority over forward progression: a stage 5 IR that is stale because `spec.md` was just edited must be rebuilt before `/plan` is recommended again, even if `/plan` has never been run. Use this precedence:

```
any stage stale → re-run the producing command for the earliest stale stage
                  (reason: "<upstream-file> edited after <downstream-artifact>")
missing inventory  → /biztalk-reverse-engineer <source>
missing spec       → /specify
open OQs > 0       → /clarify
missing data model → /model
missing contracts  → /contracts
missing mappings   → /map
missing IR         → /architect
missing mapping tests → /test-mappings <folder>
missing flow tests    → /test-flows <folder>  (only when any flow declares tests[])
review not run OR sev1 > 0 → /review <folder>
no platform pack   → /platform <pack>
missing plan       → /plan <folder>
missing tasks      → /tasks <folder>
missing impl       → /implement-<plat> <folder>
missing tests      → /test-<plat> <folder>
never deployed     → /deploy-<plat> <folder>
all green          → "Pipeline complete. Re-run /review after any source change."
```

Do not invent new next-step strings — the visualizer's stage buttons are keyed off the slash command names. For greenfield navigation, stages 6 and 6a are part of the visible path.

## counts block

Populate from the produced reports. Use `null` (not `0`) when a report has not been produced yet.

```json
{
  "openClarifications": <int>,
  "closedClarifications": <int>,
  "sev1": <int|null>,
  "sev2": <int|null>,
  "sev3": <int|null>,
  "blockedFlows": <int>,
  "azureFunctionDeps": <int>,
  "localFunctionDeps": <int>,
  "msisCracked": <int>
}
```

`openClarifications` / `closedClarifications` come from the dual-gate rule (Resolved:true AND log row complete = closed).

## Output schema

```json
{
  "folder": "specs/<domain>/NNN-<slug>",
  "generatedAt": "<ISO-8601 UTC>",
  "refreshedBy": "<slash-command that wrote this file, e.g. /review>",
  "activePlatform": "<pack-name or null>",
  "stages": [
    { "id": "0",  "name": "Inventory",     "status": "done|missing|blocked|covered|stale", "summary": "..." }
  ],
  "counts": { },
  "staleness": [
    { "stage": "5", "stagename": "IR", "stalerThan": "spec.md", "reason": "spec.md edited after integration-ir.yaml" }
  ],
  "staleness_probed": true,
  "next": { "command": "/<slash-command> <folder>", "reason": "..." },
  "coverage": { "flowsTotal": 7, "flowsWithTests": 5, "mappingsTotal": 12, "mappingsDocumented": 12 },
  "blockedFlowIds": ["order-intake", "legacy-edi-passthrough"],
  "stageTiming": { "5": { "completedAt": "<ISO-8601 UTC>", "elapsedMs": 4200 } }
}
```

`staleness` is an array (possibly empty). Each entry names a stage whose primary artifact is older than at least one upstream source, names the upstream, and gives a one-sentence reason that the visualizer / `/next` can quote verbatim.

`refreshedBy` is the literal slash-command name (with leading `/`) of the prompt performing the refresh. The visualizer displays it in the Migration Status panel footer so users can see at a glance which command last touched the file.

### Richer e2e fields (optional)

These three keys are **advisory** — they drive the VS Code progress cockpit but gate nothing. The always-on `refresh-status.ps1` hook derives them from files it already reads, so no agent must populate them by hand; an agent MAY refine them when it has authoritative data.

- **`coverage`** — `{ flowsTotal, flowsWithTests, mappingsTotal, mappingsDocumented }`. `flowsTotal` / `flowsWithTests` / `mappingsTotal` come from a line scan of `integration-ir.yaml`'s `flows:` and `mappings:` sections; `mappingsDocumented` is the count of `mappings/*.md` STM files. Omit the whole object when no IR exists yet.
- **`blockedFlowIds`** — string[] of the flow ids carrying a `# BLOCKED:` marker in the IR (the named counterpart to `counts.blockedFlows`). Empty array when none.
- **`stageTiming`** — `{ "<stageId>": { completedAt, elapsedMs } }`. `completedAt` is stamped (UTC ISO-8601) when a stage first reaches `done`/`covered` and is **preserved across rebuilds**; `elapsedMs` is the gap to the previously-completed stage, a rough per-stage duration.

Preserve these the same way as `artifactHashes` / `lastImplement` when refreshing — never wipe a prior `stageTiming.completedAt`.

## Post-refresh chat guidance

After refreshing `<folder>/status.json`, prefer a short question over a static block:

- Ask: `What do you want to do next?`
- Explain the recommendation first with `Why: <next.reason>`.
- If the chat surface supports selectable options, present fixed choices.
- Otherwise present a short numbered list.
- Include `Run recommended step: <next.command>` as the first option.
- The second option may be context-specific (for example a guided alternative or the main recovery path).
- Always include `Stop here` as the final option.

This keeps the next-step guidance actionable without forcing the user to remember or retype the command immediately.

## Refresh protocol

At the end of any non-read-only pipeline prompt:

1. Determine the integration folder (already resolved earlier in the prompt).
2. Probe every stage row above from disk. Do **not** trust the previous `status.json` — overwrite from scratch.
3. Compare mtimes per the Staleness section. Mark stale stages and populate the `staleness` array.
4. Set `generatedAt` to the current UTC timestamp.
5. Set `refreshedBy` to the slash-command name of the running prompt (e.g. `/review`, `/clarify`, `/implement-azure`).
6. Set `activePlatform` from `.spec2integration/state.json` if present, else `null`.
7. Compute `next` from the precedence table (staleness wins over forward progression).
8. Write the file. This is the prompt's last write; if it fails, surface the error but do not retry the entire pipeline.

This refresh is the **only** authorised mutation of `status.json` outside `/status` itself. It does not violate Article VIII because the file is per-integration derived state, not pipeline-global mutable state.

## Sub-agents MUST NOT write `status.json`

Only the calling slash-command refreshes `status.json`. Sub-agents (anything invoked via the `Agent` tool — i.e. files under any plugin's `agents/` directory) **MUST NOT** create or modify `status.json` under any circumstances, even when they have `Write` or `Edit` in their tool list and are the last step before the orchestrator returns. This is a hard rule with three reasons:

1. **`refreshedBy` provenance.** The visualizer reads `refreshedBy` to show which slash-command last touched the file. A sub-agent writing it would set `refreshedBy` to its own name, hiding the actual orchestrator and confusing users.
2. **One-write-per-run.** Sub-agents run in parallel inside a prompt; if any of them write `status.json`, the result is a race. The prompt's final refresh is the single serialisation point.
3. **Stage probe consistency.** A sub-agent writes mid-run, before sibling agents have finished. Its probe sees a partial folder state and produces wrong stage values.

If you are a sub-agent and your output spec or summary mentions `status.json`, that is a documentation bug — record the intended status update in your run summary as plain text (e.g. "Stage 5 (IR) is now `done` with N flows / M channels") so the calling prompt can use it during the final refresh, but do not write the file yourself.
