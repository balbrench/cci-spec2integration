---
description: [Manual] Produce tasks.md via the task-decomposer agent.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Invoke the `task-decomposer` agent.

Steps:
1. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md` (explicit argument → active integration → sole candidate → ask), then **pin** the resolved folder as `activeIntegration` in `.spec2integration/state.json`.
2. Require `plan.md` to exist; otherwise instruct the user to run `/plan` first.
3. Call the `task-decomposer` agent.
4. Print total task count, parallelizable count, and a list of phases.
5. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 9 (Tasks) as `done` and recompute `next`.
6. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Print `Why: <next.reason>` before the choices.
	- Offer these choices:
	  - `Run recommended step: <next.command>`
	  - `Switch to guided mode: /run-pipeline --folder <folder>`
	  - `Stop here`
