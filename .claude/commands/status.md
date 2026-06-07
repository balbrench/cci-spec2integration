---
description: [Reporting] Show pipeline progress for an integration folder — what's done, what's stale, what's blocked, what's next. Read-only.
argument-hint: [spec-folder]
allowed-tools: Read, Grep, Glob, Bash
---

Show migration status for an integration folder. This prompt is **read-only** — it does not invoke any agent and does not mutate any file. It scans the folder and prints a checklist plus a recommended next command.

Steps:

1. Resolve the integration folder:
   - If `$ARGUMENTS` is provided and resolves to a directory, use it.
   - Else if `.spec2integration/state.json` has `activeIntegration` set and that folder exists, use it.
   - Else look for a single subfolder under `specs/` containing `spec.md` (e.g. `specs/biztalk/NNN-<slug>/` or `specs/NNN-<slug>/`). If multiple, list them and ask the user to pick one.
   - Else stop with: "No integration folder found. Run `/specify` (greenfield) or `/biztalk-reverse-engineer` (BizTalk) first, or pin one with `/use <folder>`."

   This is a read-only command: consult `activeIntegration` as a default but do **not** modify it.

2. Probe the following artifacts and record `done | missing | blocked | covered | stale` for each. Read each file only once; cache findings. (Staleness is computed in step 3 — leave the initial probe at `done`/`missing`/`blocked` and let step 3 upgrade `done` → `stale` where appropriate.)

   | Stage | Artifact | Done check |
   |---|---|---|
   | 0 Source inventory (BizTalk only) | `specs/biztalk/biztalk-inventory.md` | file exists; count `migrationHint:` lines |
   | 1 Spec | `<folder>/spec.md` | file exists; count `OQ-` lines |
   | 1a Clarifications | `<folder>/clarifications.md` | file exists OR spec.md says "no open clarifications" |
   | 2 Data model | `<folder>/data-model.md` | file exists |
   | 3 Contracts | `<folder>/contracts/openapi.yaml` AND `contracts/asyncapi.yaml` AND any file under `contracts/schemas/` | all three present |
   | 3a Contracts lint | `<folder>/contract-lint-report.json` | exists; verdict `PASS` |
   | 4 Mappings (STM) | `<folder>/mappings/*.md` | one per `mappings[].name` in IR |
   | 5 IR | `<folder>/integration-ir.yaml` | file exists; count `flows:`, `channels:`, `mappings:`, BLOCKED-comments |
   | 5a IR validation | `<folder>/ir-validation-report.json` | exists; verdict `PASS` |
   | 5b STM drift | `<folder>/stm-drift-report.json` | exists; no `STM_DRIFT` findings |
   | 5c Secret scan | `<folder>/secret-scan-report.json` | exists; zero findings |
   | 5d PII flow | `<folder>/pii-flow-report.json` | exists; verdict `PASS` |
   | 5e Review | `<folder>/review-report.json` | exists; `sev1=0` |
   | 6 Mapping tests | `<folder>/mapping-test-report.json` | exists; `failed=0` |
   | 6a Flow tests | `<folder>/flow-test-report.json` | exists; `failed=0` |
   | 7 Platform pack | `.spec2integration/state.json` | exists; `activePlatform` non-empty |
   | 8 Plan | `<folder>/plan.md` | exists (NOT `plan-blocked.md`) |
   | 9 Tasks | `<folder>/tasks.md` | exists |
   | 10 Implement | per platform — for `azure`: `<folder>/app/<flow>/workflow.json` for every non-BLOCKED flow in IR | one workflow per flow |
   | 11 Tests | per platform — for `azure`: `<folder>/tests-mstest/**/*.csproj` | exists |
   | 12 Deploy | per platform — for `azure`: `<folder>/azure.yaml` AND `<folder>/.azure/` | both exist |

3. Compute staleness per the dependency map in `.claude/skills/pipeline-status/SKILL.md`. For each downstream stage that has produced its primary artifact, use `stat -c %Y <file>` (one batched Bash call is fine — e.g. `stat -c '%Y %n' <folder>/spec.md <folder>/data-model.md <folder>/integration-ir.yaml ...`) to compare its mtime against each upstream source named in the map. For directory sources (`contracts/`, `mappings/`), take the newest mtime within the directory. Record a `staleness` entry for every downstream artifact whose mtime is older than any upstream source.

4. Determine the next recommended command using this precedence (staleness wins, then first unmet stage):

   ```
   any stage stale     → re-run the producing command for the earliest stale stage
                         (reason: "<upstream-file> edited after <downstream-artifact>")
   missing inventory   → /biztalk-reverse-engineer <source>   (BizTalk source path only)
   missing spec        → /specify
   open OQs > 0        → /clarify
   missing data model  → /model
   missing contracts   → /contracts
   missing mappings    → /map
   missing IR          → /architect
   missing mapping tests → /test-mappings <folder>
   missing flow tests    → /test-flows <folder>  (only when any flow declares tests[])
   review not run OR sev1 > 0 → /review <folder>
   no platform pack    → /platform <pack>
   missing plan        → /plan <folder>
   missing tasks       → /tasks <folder>
   missing impl        → /implement-<plat> <folder>
   missing tests       → /test-<plat> <folder>
   never deployed      → /deploy-<plat> <folder>
   all green           → "Pipeline complete. Re-run /review after any source change."
   ```

   The producing command for each stage:
   `1→/specify`, `1a→/clarify`, `2→/model`, `3→/contracts`, `4→/map`, `5→/architect`,
   `5e→/review`, `6→/test-mappings`, `6a→/test-flows`, `8→/plan`, `9→/tasks`,
   `10→/implement-<plat>`, `11→/test-<plat>`.

5. Print the status block (use ASCII `[x]` / `[ ]` / `[!]` / `[~]`; never emojis):

   ```
   === Migration Status: <folder> ===
   Active platform pack: <name or "(none — run /platform <pack>)">

   [x] 0a  Inventory          biztalk-inventory.md            (NN artifacts, NN manual)
   [x] 0b  Catalogue          integration-catalogue.md        (NN integration boundaries)
   [x] 1   Spec               spec.md                         (NN OQs open)
   [ ] 1a  Clarifications     clarifications.md               — not run
   [ ] 2   Data model         data-model.md                   — not run
   [x] 3   Contracts          contracts/                      (NN schemas, NN openapi ops, NN asyncapi ch)
   [ ] 3a  Contracts lint     contract-lint-report.json
   [x] 4   Mappings (STM)     mappings/*.md                   (M/N)
   [x] 5   IR                 integration-ir.yaml             (NN flows, NN channels, NN BLOCKED)
   [ ] 5a  IR validation      ir-validation-report.json
   [ ] 5b  STM drift          stm-drift-report.json
   [ ] 5c  Secret scan        secret-scan-report.json
   [ ] 5d  PII flow           pii-flow-report.json
   [ ] 5e  Review             review-report.json              — sev1: -, sev2: -, sev3: -
   [ ] 6   Mapping tests      mapping-test-report.json        — pass: -, fail: -
   [ ] 6a  Flow tests         flow-test-report.json           — pass: -, fail: -
   [ ] 7   Platform pack      .spec2integration/state.json    — none installed
   [ ] 8   Plan               plan.md
   [ ] 9   Tasks              tasks.md
   [ ] 10  Implement          app/<flow>/workflow.json        (M/N flows generated)
   [ ] 11  Tests              tests-mstest/**/*.csproj
   [ ] 12  Deploy             azure.yaml + .azure/

   Open clarifications : N
   Sev-1 findings      : N (or "—" if not run)
   BLOCKED flows       : N
   Stale stages        : N
   azure-function deps : N

   Next step: <recommended command>
   ```

   Conventions:
   - `[x]` complete, `[ ]` not started, `[!]` started but blocked (e.g. `plan-blocked.md` exists, `review-report.json` has Sev-1, tests have failures), `[~]` started but stale (an upstream source was edited after this artifact was produced — see Staleness).
   - Stages 0a, 0b, and 5 always show counts in parentheses.
   - Stages with reports show their verdict / counts inline.
   - Trailing dashes (`—`) mean "report not produced".
   - For each `[~]` row, append `stale: <upstream> newer` to the line (e.g. `[~] 5   IR ... stale: spec.md newer`).

6. If `staleness` is non-empty, print a `Stale stages:` section listing each entry with the upstream that triggered it:

   ```
   Stale stages:
     - Stage 5 (IR): spec.md edited after integration-ir.yaml
     - Stage 8 (Plan): integration-ir.yaml edited after plan.md
   To resolve: re-run the producing command for the earliest stale stage, or use
   `/run-pipeline --folder <folder>` to resume from that stage.
   ```

7. Also write a machine-readable `<folder>/status.json` so the IR visualizer can render a status pill. Schema:

   ```json
   {
     "folder": "<relative path>",
     "generatedAt": "<ISO-8601 UTC>",
     "refreshedBy": "/status",
     "activePlatform": "<name or null>",
     "stages": [
       { "id": "0a", "name": "Inventory", "status": "done|missing|blocked|covered|stale", "summary": "..." },
       { "id": "0b", "name": "Catalogue", "status": "done|missing|blocked|covered|stale", "summary": "..." },
       { "id": "1",  "name": "Spec",      "status": "done|missing|blocked|covered|stale", "summary": "..." }
     ],
     "counts": {
       "openClarifications": 0,
       "closedClarifications": 0,
       "sev1": null,
       "sev2": null,
       "sev3": null,
       "blockedFlows": 0,
       "staleStages": 0,
       "azureFunctionDeps": 0
     },
     "staleness": [
       { "stage": "5", "stagename": "IR", "stalerThan": "spec.md", "reason": "spec.md edited after integration-ir.yaml" }
     ],
     "staleness_probed": true,
     "next": { "command": "/review specs/...", "reason": "review not yet run" }
   }
   ```

   `refreshedBy` is set by whichever prompt last wrote the file (e.g. `/review`, `/clarify`, `/status`). This is purely diagnostic — the visualizer uses it for the footer.

   **Preserved keys (do not overwrite):** If the existing `status.json` contains `artifactHashes` or `lastImplement` (written by `/implement-<platform>`), carry them forward unchanged into the new write. These keys are owned by the implement command, not by `/status`. Wiping them would break `/drift-check`.

8. Print one final line:

   ```
   Last refresh: <refreshedBy> at <generatedAt>. Tip: open the IR visualizer (Spec2Integration VS Code extension → Open IR Visualizer) for a graphical view of this status.
   ```

Notes:
- This prompt MUST NOT call any agent. It MUST NOT modify `spec.md`, `integration-ir.yaml`, or any artifact other than `<folder>/status.json`.
- `status.json` is the only mutation; it is purely derived state and may be regenerated at any time. It does not violate Article VIII because it is per-integration, not pipeline-global mutable state.
- For a BizTalk folder where there are no MSIs (and inventory was produced from source), still mark stages 0a (Inventory) and 0b (Catalogue) as `done`.
