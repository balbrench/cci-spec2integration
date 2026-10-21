---
description: [Reporting] Reconcile the spec and IR against the generated artifacts — what is declared but not implemented, implemented but not declared, and which transforms can't be confirmed. Advisory and read-only.
argument-hint: [spec-folder]
allowed-tools: Read, Grep, Glob, Agent, Bash
---

Reconcile an integration's **declared intent** (`integration-ir.yaml` and the requirements traced to it) with its **generated artifact tree**, and report where they disagree. On a post-implementation integration the artifacts are the source of truth and the spec and IR drift away from them; this command makes that drift visible.

It answers a different question from its neighbours:

| Command | Question |
|---|---|
| `/drift-check` | Did a generated file change since `/implement`? (hashes) |
| `/reconcile` | Do the generated artifacts still match the spec and IR? (meaning, not hashes) |
| `/analyze` | Do all the artifacts agree with each other? (aggregates this report with the other checkers) |
| `/review` | Is the integration constitutionally compliant? (the blocking verdict; does not include this report) |

This command is **read-only with respect to pipeline artifacts**: the reconciler writes only `reconciliation-report.md` / `.json`, and nothing touches `spec.md`, `integration-ir.yaml`, `status.json`, or any generated file. It is **advisory**: every finding is Sev-3, the verdict gates nothing, and it is not guarded by the lifecycle guard (it never regenerates). That makes it the natural check to run after deployment.

## Steps

1. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md`. This is a read-only command: consult `activeIntegration` as a default but do **not** pin or modify it.

2. Require `<folder>/integration-ir.yaml`. If it is missing, stop with: `No integration-ir.yaml in <folder> — run /architect first; there is nothing to reconcile.`

3. **Resolve the platform reconciler.** Read `activePlatform` from `.spec2integration/state.json`. If it is empty, stop with: `No active platform pack — run /platform <pack> first.` The reconciler is the agent `<activePlatform>-spec-code-reconciler` (for Azure, `azure-spec-code-reconciler`). If `.claude/agents/<activePlatform>-spec-code-reconciler.md` does not exist, stop with: `The <activePlatform> pack has no spec↔code reconciler.`

4. **Refresh the requirement matrix when needed.** The reconciler's requirement direction reads `spec-coverage-report.json`. If `<folder>/spec.md` exists and the report is missing, or older than `spec.md` or `integration-ir.yaml` (compare modification times with Bash), invoke `spec-coverage-checker` on the folder first and wait for it (it is a read-only checker that writes only its own reports). If `spec.md` does not exist, skip this step; the reconciler runs the other three directions.

5. Invoke the reconciler via the `Agent` tool with `subagent_type: <activePlatform>-spec-code-reconciler` and the folder path.

6. Print the reconciler's one-line summary, the verdict, and the path to `<folder>/reconciliation-report.md`. If the verdict is `DIVERGED`, list the first five findings (finding, location, detail).

7. Ask one short follow-up: `What do you want to do next?` with choices derived from the findings, for example:
   - `Re-baseline the IR to match the deployed artifacts: /change "<…>" <folder>`
   - `The spec/IR is right — regenerate the missing artifact` (only when `lifecycle` is not `post-implementation`)
   - `See everything in one table: /analyze <folder>`
   - `Stop here`

## Notes

- Platform-neutral: the command dispatches on `activePlatform`; each pack supplies its own `<plat>-spec-code-reconciler` that knows its artifact layout.
- The reconciler never reads `spec.md` directly (Article II); requirement text reaches it through `spec-coverage-report.json`.
- `/analyze` runs the reconciler too and merges its findings under a **Spec↔code** heading. Run `/reconcile` on its own when you only want the spec↔code view.
