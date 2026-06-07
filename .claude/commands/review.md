---
description: [Recovery] Audit every artifact in the integration folder against the constitution via the reviewer agent.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Steps:
1. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md` (explicit argument → active integration → sole candidate → ask), then **pin** the resolved folder as `activeIntegration` in `.spec2integration/state.json`.
2. **Pre-gate.** Call the `ir-validator` agent with the integration folder path. If it returns `BLOCKED`, print its Sev-1 findings and stop — do not proceed further. (This runs first, alone, so the parallel validators below never waste work on a structurally invalid IR.)
3. **Parallel validator fan-out.** These validators share no inputs or outputs and are safe to run concurrently. Issue all their `Agent` calls in a **single message** so they execute in parallel, then wait for every one to finish before continuing:
   - `stm-drift-checker` — collect its findings; do not stop on drift (the reviewer aggregates them).
   - `pii-flow-checker` — collect its findings under Article V; any Sev-1 PII leak blocks the overall verdict.
   - `spec-coverage-checker` — collect its findings; any Sev-1 `FR_NOT_SATISFIED` blocks the overall verdict.
   - `secret-scanner` — **include in the batch only when the integration is reverse-engineered** (i.e. `<folder>/integration-ir.yaml` contains a top-level `source:` block — typically `source.platform: biztalk`). Any Sev-1 secret finding is included in the overall verdict. **Omit it for greenfield integrations**: the constitution's Article V audit (performed by the reviewer in step 4) covers the "no inline secrets" requirement for code we generate ourselves, and the scanner is only valuable when pre-existing artifacts (BizTalk MSIs, binding files, decompiled DLLs) may carry inline credentials.
4. Call the `reviewer` agent with the integration folder path. The reviewer reads `ir-validation-report.json`, `stm-drift-report.json`, `secret-scan-report.json`, `pii-flow-report.json`, and `spec-coverage-report.json` and aggregates all findings into `review-report.md` and `review-report.json`.
5. Print the overall verdict (PASS or BLOCKED) and the counts of Sev-1, Sev-2, Sev-3 findings. Then print these severity definitions verbatim so the user does not have to consult CLAUDE.md to interpret the result:

   ```
   Sev-1 = hard blocker. `/plan` and `/implement-<plat>` will refuse to run while any Sev-1 is open.
   Sev-2 = soft blocker. Must be fixed before merge. Override for this run with `/review <folder> --allow-sev2`.
   Sev-3 = advisory. Listed in the report; does not change the verdict.
   ```

   If any Sev-2 findings are present, also print: `To proceed past Sev-2 for this run only, re-run with: /review <folder> --allow-sev2`.
6. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stages 5a (IR validation) and 5e (Review) as `done`; mark 5b (STM drift) and 5d (PII flow) as `covered`. For 5c (Secret scan): mark `covered` when the scanner ran (biztalk path), or `done` with summary `not applicable (greenfield)` when it was skipped. Populate `counts.sev1`/`sev2`/`sev3` from review-report.json.
7. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Print `Why: <next.reason>` before the choices.
	- Offer these choices:
	  - `Run recommended step: <next.command>`
	  - `Fix the Sev-1 findings in <folder>/review-report.md, then re-run /review <folder>`
	  - `Stop here`
