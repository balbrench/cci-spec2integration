---
description: [Recovery] Run the LogicAppUnit test suites for all generated flows.
allowed-tools: Read, Grep, Glob, Bash
---

Steps:
1. Read `.claude/skills/runtime-validation-and-testing/SKILL.md` and apply it as the execution contract for this prompt.
2. Verify a test project exists under `tests-mstest/` or `tests/`. Prefer `tests-mstest/` when both exist.
3. Run `dotnet restore <tests-folder>` (and `dotnet build <tests-folder>/<Solution>.sln -c Debug` once — building via the `.sln` is fine).
4. **Run each flow test project in its OWN `dotnet test` process, sequentially — do NOT run `dotnet test <Solution>.sln` (or `dotnet test <tests-folder>`) in a single invocation.** Per `logic-apps-standard-testing` skill §9 [VERIFIED], the Logic Apps `UnitTestExecutor` shares process/working-directory state, so co-hosting multiple flow assemblies in one `dotnet test` run flaps (~2 failures/project) even with `MaxCpuCount=1`, while every project passes in isolation. Loop, e.g.:
   ```bash
   set -euo pipefail; failed=0
   for proj in <tests-folder>/*/*.Tests.csproj; do
     name="$(basename "$proj" .csproj)"
     dotnet test "$proj" --no-build --settings <tests-folder>/.runsettings \
       --logger "trx;LogFileName=$name.trx" --results-directory ./TestResults/$name || failed=1
   done
   exit "$failed"
   ```
   Aggregate pass/fail across all per-project runs for the summary.
5. If the generated Logic Apps project exists locally, run runtime validation per the skill: start the app locally, verify it starts cleanly, and note any runtime configuration or artifact-loading failures.
6. Report pass/fail summary. If any test fails, list the failing tests. If runtime startup fails, list the blocking startup errors separately.
7. Require or refresh `TEST-REPORT.md` in the project root when end-to-end testing has been executed for the integration; include field-level output-validation results when available.
8. Write the machine-readable execution result to `<folder>/tests-mstest/test-results.json` so the status rebuild (and the auto refresh hook) report the outcome instead of reverting stage 11 to a generation-only summary:

   ```json
   { "passed": <N>, "failed": <M>, "verdict": "PASS|BLOCKED", "executedAt": "<ISO-8601>", "runtimeValidation": "pass|blocked|skipped" }
   ```

   Then refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 11 (Tests) as `done` with summary `MSTest executed: N/total passed`; if `failed > 0` (or runtime validation is blocked) mark `blocked` with `MSTest executed: N/total passed, M failed`. Keep the summary consistent with what `scripts/refresh-status.ps1` derives from `test-results.json`, so the tree and `/status` always agree.
9. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Print `Why: <next.reason>` before the choices.
	- Offer these choices:
	  - `Run recommended step: <next.command>`
	  - `Fix TEST-REPORT.md failures, then re-run /test-azure <folder>`
	  - `Stop here`
