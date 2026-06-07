---
description: [Manual] Produce plan.md and research.md via the planner agent, enforcing constitution phase gates.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Steps:
1. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md` (explicit argument → active integration → sole candidate → ask), then **pin** the resolved folder as `activeIntegration` in `.spec2integration/state.json`.
2. Verify `.spec2integration/state.json` exists and names an installed platform pack. If not, stop and ask the user to run `/platform <pack>`.
3. Call the `mapping-tester` agent with the integration folder path. Halt only if it reports actual test failures (`failed > 0`). If it returns `BLOCKED` solely because of a missing runtime (Sev-1 `RUNTIME_MISSING`, e.g. `xsltproc` not on PATH) and `failed == 0`, surface the warning and continue — the lifted transforms will be re-exercised by the platform pack's workflow tester against the real XSLT runtime during `/implement-azure` / `/test-azure`. If `--allow-sev2` is present on the prompt arguments, also tolerate Sev-2 mapping-tester findings.
4. Call the `planner` agent. If it writes `plan-blocked.md` instead of `plan.md`, surface the failing gates and stop.
5. On success, print the active platform pack, count of phases, and count of FRs and NFRs covered.
6. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 8 (Plan) as `done` and recompute `next`.
7. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Print `Why: <next.reason>` before the choices.
	- Offer these choices:
	  - `Run recommended step: <next.command>`
	  - `Fix the gates in <folder>/plan-blocked.md, then re-run /plan <folder>`
	  - `Stop here`
