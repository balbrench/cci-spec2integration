---
description: [Recovery] Execute all mapping test fixtures declared in integration-ir.yaml via the mapping-tester agent.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent, Bash
---

Invoke the `mapping-tester` agent.

Steps:
1. Resolve the integration folder (argument or most recently modified `specs/*/*/`).
2. Verify `integration-ir.yaml` exists in the integration folder. If not, instruct the user to run `/architect` first.
3. Call the `mapping-tester` agent with the integration folder path.
4. Print the verdict (PASS or BLOCKED) and the counts of passed, failed, and skipped tests.
5. If BLOCKED, list each FAIL finding by mapping name and test fixture so the user knows exactly what to fix.
6. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 6 (Mapping tests) as `done` with summary `pass: N, fail: N, skip: N`; if `failed > 0` mark `blocked` instead.
7. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Print `Why: <next.reason>` before the choices.
	- Offer these choices:
	  - `Run recommended step: <next.command>`
	  - `Repair the failing mapping rules, then re-run /test-mappings <folder>`
	  - `Stop here`
