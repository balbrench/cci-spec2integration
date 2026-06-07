---
description: [Recovery] Execute all flow test fixtures declared in integration-ir.yaml via the flow-tester agent.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent, Bash
---

Invoke the `flow-tester` agent.

Steps:
1. Resolve the integration folder (argument or most recently modified `specs/*/*/`).
2. Verify `integration-ir.yaml` exists in the integration folder. If not, instruct the user to run `/architect` first.
3. Verify at least one flow declares `tests[]`. If none do, print `No flow tests declared — nothing to do.` and exit 0 (not an error).
4. Call the `flow-tester` agent with the integration folder path.
5. Print the verdict (PASS or BLOCKED) and the counts of passed, failed, and skipped tests.
6. If BLOCKED, list each FAIL by flow name and test name with a one-line diff excerpt so the user knows exactly what to fix.
7. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 6a (Flow tests) as `done` with summary `pass: N, fail: N, skip: N`; if `failed > 0` mark `blocked` instead.
8. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Print `Why: <next.reason>` before the choices.
	- Offer these choices:
	  - `Run recommended step: <next.command>`
	  - `Repair the failing flow behavior, then re-run /test-flows <folder>`
	  - `Stop here`

Example:

```
/test-flows examples/order-processing-azure/specs/001-order-processing
```
