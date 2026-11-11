---
description: [Reporting] Show pipeline progress for an integration folder — what's done, what's stale, what's blocked, what's next. Read-only.
argument-hint: [spec-folder]
allowed-tools: Read, Grep, Glob, Bash
---

Show migration status for an integration folder. This prompt is **read-only** with respect to pipeline artifacts — it does not invoke any agent. It runs `scripts/refresh-status.ps1` to rebuild `<folder>/status.json`, then prints a checklist plus the recommended next command from that file.

Steps:

1. Resolve the integration folder:
   - If `$ARGUMENTS` is provided and resolves to a directory, use it.
   - Else if `.spec2integration/state.json` has `activeIntegration` set and that folder exists, use it.
   - Else look for a single subfolder under `specs/` containing `spec.md` (e.g. `specs/biztalk/NNN-<slug>/` or `specs/NNN-<slug>/`). If multiple, list them and ask the user to pick one.
   - Else stop with: "No integration folder found. Run `/specify` (greenfield) or `/biztalk-reverse-engineer` (BizTalk) first, or pin one with `/use <folder>`."

   This is a read-only command: consult `activeIntegration` as a default but do **not** modify it.

2. Rebuild the status file. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/refresh-status.ps1 -Folder <folder> -RefreshedBy /status` (pwsh on Linux/macOS). The script is the only writer of `<folder>/status.json`: it probes every stage from disk (artifacts and the verdicts inside report files), computes staleness from mtimes, computes `next`, and carries forward the preserved keys (`artifactHashes`, `lastImplement`, `lifecycle`, `stages[].frozen`, `specCoverage`). Do not probe stages, compute staleness or `next`, or write `status.json` yourself. If the script fails, print its error output and stop.

3. Read `<folder>/status.json` and take from it: `activePlatform`, `lifecycle`, `stages[]` (id, name, status, summary, frozen), `counts`, `staleness`, `next`, `refreshedBy`, `generatedAt`.

4. Render every row from the `stages[]` entries; do not re-derive a status or summary. Map `status` to the marker: `done`/`covered` → `[x]`, `missing` → `[ ]`, `blocked` → `[!]`, `stale` → `[~]`.

5. Print the status block (use ASCII `[x]` / `[ ]` / `[!]` / `[~]`; never emojis). The text after each artifact column is the row's `summary`; the footer counts come from `counts` and `staleness`; `Next step` is `next.command` (followed by `Why: <next.reason>`):

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

7. Print one final line:

   ```
   Last refresh: <refreshedBy> at <generatedAt>. Tip: open the IR visualizer (Spec2Integration VS Code extension → Open IR Visualizer) for a graphical view of this status.
   ```

Notes:
- This prompt MUST NOT call any agent. It MUST NOT modify `spec.md`, `integration-ir.yaml`, or any other artifact, and it does not edit `<folder>/status.json` itself — the script writes it.
- `status.json` is purely derived state and may be regenerated at any time. It does not violate Article VIII because it is per-integration, not pipeline-global mutable state. See the `pipeline-status` skill for the stage table, staleness map and next-step precedence the script applies.
