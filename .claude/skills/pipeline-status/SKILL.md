---
name: pipeline-status
description: How `<folder>/status.json` is produced — the derived per-integration status file consumed by `/status`, `/next`, the lifecycle guard and the IR visualizer's Migration Status panel. It is written only by `scripts/refresh-status.ps1`, which derives every stage from the artifacts and report verdicts on disk. Agents and commands never write stage rows; they write their own artifacts and reports.
---

# pipeline-status skill

`status.json` is **derived state with a single writer**: `scripts/refresh-status.ps1`. Every stage row is computed from disk — whether each stage's artifact exists, and the verdict recorded inside its report file — so the file cannot disagree with the folder it describes.

## Who writes status.json

**Only `scripts/refresh-status.ps1`.** It runs in two ways:

1. **Automatically**, as the `PostToolUse` hook on `Write|Edit` (`.claude/settings.json`). After any Write/Edit inside `specs/<domain>/NNN-<slug>/` it rebuilds that folder's `status.json`; after an edit to a shared input (`specs/PRD.md`, `.spec2integration/state.json`, `specs/biztalk/*.md`) it rebuilds every integration. It skips edits to `status.json` itself. Either way it tags it `refreshedBy: auto:postwrite-hook`. Agents writing their artifacts and reports with the Write/Edit tools therefore trigger it without doing anything.
2. **Directly**, by a command that has Bash/PowerShell (`/status`, `/implement-azure`, `/test-azure`, `/test-mappings`, `/test-flows`, `/deploy-azure`, `/change`, `/biztalk-reverse-engineer`) or by hand:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/refresh-status.ps1 -Folder <folder> -RefreshedBy /<command>
   ```
   (`pwsh` on Linux/macOS.) Use this after edits the hook cannot see: Bash or script edits, edits made outside Claude Code, CI, or a session where hooks are disabled.

**Agents MUST NOT write `status.json`.** An agent reports its outcome by writing its own artifact and, where it has a verdict, its report file (the stage table below lists which). If an agent has an outcome with no report file, the fix is to give it a report file that the script reads, not to write a stage row. Reasons:

1. **No drift.** A row computed from disk cannot contradict disk; a hand-written row can, and nothing would catch it.
2. **No races.** Agents run in parallel inside a command; one writer means no lost merges.
3. **Provenance.** `refreshedBy` names the command or the hook that rebuilt the file, not a sub-agent.

**Commands** do not write stage rows either. A command with Bash/PowerShell runs the script with `-Folder` as its last step; a command without it relies on the hook (its agents' Write/Edit calls trigger it) and, in its closing message, tells the user to run `/status <folder>` if the status looks out of date.

### Keys the script preserves, and who writes them

A few keys cannot be derived from disk. The script carries them forward verbatim on every rebuild; only the named writer changes them:

| Key | Written by | Why it cannot be derived |
|---|---|---|
| `artifactHashes`, `lastImplement` | `/implement-azure` (step 11), `/change` | the `/drift-check` baseline: the hashes as they were at generation time |
| `lifecycle`, `stages[].frozen` | `/lifecycle` only | a deliberate user decision (see `.claude/skills/lifecycle-guard/SKILL.md`) |
| `specCoverage` | none (legacy) | an old summary block; kept so older files do not lose it. No agent writes it any more. |
| `stageTiming[].completedAt` | the script itself | first-completion time, kept stable across rebuilds |

A writer of one of these keys reads `status.json`, changes only its key, and writes the file back; then it runs the script (or relies on the hook) so the stage rows are rebuilt around it.

## Where each stage's outcome comes from

The producing agent writes the artifact or report; the script reads it. A stage is `blocked` when its report's `summary.verdict` is `FAIL`/`BLOCKED`, or it records `summary.sev1 > 0` or `summary.failed > 0` (top-level keys are accepted for older reports).

| Producer | Stage id(s) | The script reads |
|---|---|---|
| `biztalk-inventory` | `0a`, `0b` | `specs/biztalk/biztalk-inventory.md`, `integration-catalogue.md` |
| `biztalk-spec-author`, `requirements-analyst` | `1` | `spec.md` |
| `clarifier` | `1a` | `clarifications.md` (open/closed counts) |
| `domain-modeler` | `2` | `data-model.md` |
| `biztalk-contract-extractor`, `contract-designer` | `3` | `contracts/` |
| `contract-linter` | `3a` | `contract-lint-report.json` verdict |
| `mapping-designer` | `4` | `mappings/*.md` |
| `biztalk-ir-compiler`, `integration-architect` | `5` | `integration-ir.yaml` |
| `ir-validator` | `5a` | `ir-validation-report.json` verdict |
| `stm-drift-checker` | `5b` | `stm-drift-report.json` verdict |
| `secret-scanner` | `5c` | `secret-scan-report.json` (sev1, scanExecuted) |
| `pii-flow-checker` | `5d` | `pii-flow-report.json` verdict |
| `reviewer` | `5e` | `review-report.json` verdict / sev1 |
| `mapping-tester` | `6` | `mapping-test-report.json` passed/failed |
| `flow-tester` | `6a` | `flow-test-report.json` passed/failed |
| `/platform` | `7` | `.spec2integration/state.json` `activePlatform` |
| `planner` | `8` | `plan.md` or `plan-blocked.md` |
| `task-decomposer` | `9` | `tasks.md` |
| the `azure-*` compilers, binders and authors; `azure-reviewer`; `/implement-azure` gates | `10` | the artifact tree (`app/<flow>/workflow.json`, `FunctionApps/<flow>/`, `adf/pipelines/`), the `Verdict:` line of `azure-review.md`, and `implement-gates.json` |
| `azure-workflow-tester`, `azure-functions-compiler` (test projects); `/test-azure`; `/implement-azure` gate 8d | `11` | `tests-mstest/test-results.json`, else `implement-gates.json` `tests`, else the test projects' existence |

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
| 5a  | IR validation     | `<folder>/ir-validation-report.json` exists; `blocked` when its verdict is FAIL or it records Sev-1.          |
| 5b  | STM drift         | `<folder>/stm-drift-report.json` exists; `blocked` when its verdict is FAIL. `covered` when only `review-report.json` exists. |
| 5c  | Secret scan       | `<folder>/secret-scan-report.json` exists, OR `integration-ir.yaml` has no top-level `source:` block (greenfield → `done` with summary `not applicable (greenfield)`). May be `covered` by `/review` when the scanner runs (BizTalk path).         |
| 5d  | PII flow          | `<folder>/pii-flow-report.json` exists; `blocked` on FAIL or Sev-1. `covered` when only `review-report.json` exists. |
| 5e  | Review            | `<folder>/review-report.json` exists; `blocked` when `summary.sev1 > 0` or the verdict is BLOCKED.             |
| 6   | Mapping tests     | `<folder>/mapping-test-report.json` exists with `failed=0`.                                                   |
| 6a  | Flow tests        | `<folder>/flow-test-report.json` exists with `failed=0`.                                                      |
| 7   | Platform pack     | `.spec2integration/state.json` exists with non-null `activePlatform`. Re-probed from `state.json` on every rebuild, like every other stage. Summary: `<activePlatform>` when set, else `no active platform`. |
| 8   | Plan              | `<folder>/plan.md` exists (not `plan-blocked.md`).                                                             |
| 9   | Tasks             | `<folder>/tasks.md` exists.                                                                                    |
| 10  | Implement         | per platform — for `azure`: at least one of `<folder>/app/<flow>/workflow.json`, `<folder>/FunctionApps/<flow>/<flow>.csproj` (a Function App, i.e. with `<AzureFunctionsVersion>`), `<folder>/adf/pipelines/*.json`. Summary gives the per-bucket counts. `blocked` when `azure-review.md` has a verdict other than PASS, or `implement-gates.json` (written by `scripts/check-azure-artifacts.ps1 -ReportFile` in `/implement-azure` gates 8a–8d) records errors or a gate that failed or could not run. Without `implement-gates.json` the stage is `done` with `gates not recorded`, so an unverified tree is never shown as verified. |
| 11  | Tests             | per platform — for `azure`: the first that exists of `<folder>/tests-mstest/test-results.json` (written by `/test-azure`), the `tests` block of `<folder>/implement-gates.json` (gate 8d), or `<folder>/tests-mstest/**/*.csproj`. Executed results report `N/total passed` and are `blocked` when anything failed; projects that exist but have not run are `done` with `not yet executed`. |
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

### Staleness is always probed

The script computes staleness on every rebuild (hook or direct), so `staleness_probed` is always `true` in a file it wrote. A command without Bash does not compute staleness itself; it relies on the hook. If the hook is disabled, `/status <folder>` runs the script and probes it.

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
  "lifecycle": "generate | post-implementation",
  "stages": [
    { "id": "0",  "name": "Inventory",     "status": "done|missing|blocked|covered|stale", "frozen": false, "summary": "..." }
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

`refreshedBy` is `auto:postwrite-hook` when the hook rebuilt the file, or the `-RefreshedBy` value (a slash-command name with leading `/`) when a command ran the script directly. The visualizer displays it in the Migration Status panel footer.

`lifecycle` (`generate` by default, or absent) and the per-stage `frozen` flag are the **lifecycle-guard** fields (see `.claude/skills/lifecycle-guard/SKILL.md`). Only `/lifecycle` sets them; every rebuild by the script **preserves** them. When `lifecycle == post-implementation`, the generative commands refuse to regenerate — edits go through `/change`.

### Richer e2e fields (optional)

These three keys are **advisory** — they drive the VS Code progress cockpit but gate nothing. The script derives them from files it already reads.

- **`coverage`** — `{ flowsTotal, flowsWithTests, mappingsTotal, mappingsDocumented }`. `flowsTotal` / `flowsWithTests` / `mappingsTotal` come from a line scan of `integration-ir.yaml`'s `flows:` and `mappings:` sections; `mappingsDocumented` is the count of `mappings/*.md` STM files. Omit the whole object when no IR exists yet.
- **`blockedFlowIds`** — string[] of the flow ids carrying a `# BLOCKED:` marker in the IR (the named counterpart to `counts.blockedFlows`). Empty array when none.
- **`stageTiming`** — `{ "<stageId>": { completedAt, elapsedMs } }`. `completedAt` is stamped (UTC ISO-8601) when a stage first reaches `done`/`covered` and is **preserved across rebuilds**; `elapsedMs` is the gap to the previously-completed stage, a rough per-stage duration.

The script keeps a prior `stageTiming.completedAt` stable across rebuilds.

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

`scripts/refresh-status.ps1` performs these steps; nothing else does:

1. Resolve the integration folder (from the edited file's path in hook mode, from `-Folder` in direct mode).
2. Probe every stage row above from disk, reading report verdicts. Never trust the previous stage rows.
3. Compare mtimes per the Staleness section; mark stale stages and populate `staleness`.
4. Compute `next` from the precedence table (staleness wins over forward progression).
5. Set `generatedAt`, `refreshedBy` (`-RefreshedBy`, default `auto:postwrite-hook`) and `activePlatform`.
6. Carry forward the preserved keys listed under *Keys the script preserves*.
7. Write the file.

This does not violate Article VIII: `status.json` is per-integration derived state, not pipeline-global mutable state.

A command that needs the status (for example a phase gate) reads `status.json` after its agents have returned; if it has Bash it runs the script first so the read is current.
