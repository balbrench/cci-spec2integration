---
description: [Reporting] One consolidated cross-artifact consistency report — uncovered requirements, orphan IR constructs, orphan tasks, spec/plan contradictions, STM drift, artifact drift, and staleness. Read-only.
argument-hint: [spec-folder]
allowed-tools: Read, Grep, Glob, Agent, Bash, Write
---

Produce a **single** consistency report across every artifact in an integration folder. The pipeline already has the individual checkers (`spec-coverage-checker`, `ir-validator`, `stm-drift-checker`, `/drift-check`, `/review`); `/analyze` fans out to them and merges their findings into one conflict table so you do not have to open five reports to answer "do the spec, IR, plan, tasks, and deployed artifacts still agree?"

This command is **read-only with respect to pipeline artifacts** — it writes only its own `analysis-report.md` / `analysis-report.json` and never mutates `spec.md`, `integration-ir.yaml`, `status.json`, or any generated file. It is **advisory**: it changes no verdict and blocks no command. (It is not guarded by the lifecycle-guard — it never regenerates.)

## Steps

1. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md`. This is a read-only command: consult `activeIntegration` as a default but do **not** pin or modify it.

2. **Refresh the read-only checkers (parallel fan-out).** Issue these `Agent` calls in a single message so they run concurrently, then wait for all to finish. Each produces its own report file; none mutates pipeline artifacts. Skip any whose prerequisite artifact is missing (note it as "not run — <artifact> absent").
   - `spec-coverage-checker` → `spec-coverage-report.json` + `traceability-matrix.md` (requires `spec.md` + `integration-ir.yaml`).
   - `ir-validator` → `ir-validation-report.json` (requires `integration-ir.yaml`).
   - `stm-drift-checker` → `stm-drift-report.json` (requires `integration-ir.yaml` + `mappings/`).

3. **Read the existing reports** (do not re-run their producers): `review-report.json` (if present), `pii-flow-report.json`, `flow-test-report.json`, `mapping-test-report.json`, `contract-lint-report.json`, and `status.json` (for `staleness` and `artifactHashes`).

4. **Compute the cross-artifact conflicts** that no single checker owns:
   - **Uncovered requirements** — every `MUST`/`SHALL` clause in `spec.md` with no satisfying IR construct (from `spec-coverage-report.json`, ruleId `FR_NOT_SATISFIED`).
   - **Orphan IR constructs** — IR flows/channels/mappings that trace back to no requirement (from `spec-coverage-report.json`).
   - **Orphan tasks** — tasks in `tasks.md` whose `<links: …>` reference an IR flow, mapping, channel, or contract that does not exist in `integration-ir.yaml` / `contracts/`. Grep `tasks.md` for the referenced names and confirm each exists.
   - **Plan ⇄ spec contradictions** — choices stated in `plan.md` that contradict a spec clause (e.g. plan picks a host/pattern a non-functional requirement forbids, or a flow the spec marks out-of-scope). Report as advisory observations with the two conflicting lines quoted.
   - **STM drift** — `STM_DRIFT` findings from `stm-drift-report.json`.
   - **Artifact drift** — when `status.json` has `artifactHashes`, recompute SHA-256 for a sample of the recorded files (PowerShell `Get-FileHash`, or `sha256sum`) and flag any whose digest no longer matches (same check as `/drift-check`). Note hand-edits that have not been re-baselined.
   - **Staleness** — every entry in `status.json.staleness` (upstream edited after a downstream artifact). If `status.json` is Bash-stale (`staleness_probed: false`), recompute mtimes per the dependency map in the `pipeline-status` skill.

5. Write `<folder>/analysis-report.md` — a single conflict table, most-serious first:
   ```
   # Analysis: <folder>
   Generated: <ISO-8601 UTC>   (advisory — changes no verdict, blocks nothing)

   | # | Category | Artifact | Detail | Suggested fix |
   |---|---|---|---|---|
   | 1 | UNCOVERED_REQUIREMENT | spec.md FR-07 | No IR flow satisfies "…" | /architect, or add a flow |
   | 2 | ORPHAN_TASK | tasks.md T042 | links IR flow 'order-retry' which is absent | fix the link or add the flow |
   | 3 | ARTIFACT_DRIFT | adf/pipelines/Deliver.json | hash ≠ baseline; hand-edited since /implement | re-baseline via /change or /drift-check |
   | … |
   ```
   Group the body under headings (Coverage, Traceability, Tasks, Plan consistency, Drift, Staleness) and end with a one-line **Summary** counting findings per category. Also emit `<folder>/analysis-report.json` with the same findings as an array (`{ id, category, artifact, detail, suggestedFix }`).

6. Print the summary counts and the path to the report, then ask one short follow-up: `What do you want to do next?` with choices derived from the top findings (e.g. `Re-run /architect to cover the missing requirement`, `Fix orphan links in tasks.md`, `Re-baseline drift: /change or /drift-check <folder>`, `Stop here`).

## Notes

- `/analyze` does not call `reviewer` (which writes the authoritative blocking verdict) — it aggregates the lighter read-only checkers plus the cross-artifact joins. Run `/review` when you need the constitutional PASS/BLOCKED verdict; run `/analyze` when you want a fast, non-blocking map of where the artifacts have drifted out of agreement.
- Nothing here blocks a command. Every finding names the command that would fix it.
