---
description: [Manual] Produce data-model.md for the most recent spec via the domain-modeler agent.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Invoke the `domain-modeler` agent.

Steps:
1. Resolve the target integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md` (explicit argument → active integration → sole candidate → ask), then **pin** the resolved folder as `activeIntegration` in `.spec2integration/state.json`.
2. If `clarifications.md` has unresolved Sev-1 questions, stop and ask the user to resolve them first.
3. Call the `domain-modeler` agent with the folder path.
4. Print the path to `data-model.md` and counts of entities, events, commands, and lookups. Also print this note verbatim:

   ```
   NOTE: data-model.md drives contracts/, mappings/, and integration-ir.yaml. If you
   edit it later, run `/status <folder>` to see which stages are now stale, then
   `/run-pipeline --folder <folder>` to resume from the first stale stage.
   ```
5. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 2 (Data model) as `done` and recompute `next`.
6. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Always include these choices:
	  - `Run recommended step: <next.command>`
	  - `Switch to guided mode: /run-pipeline --mode greenfield --folder <folder>`
	  - `Stop here`
	- Also print `Why: <next.reason>` before the choices so the recommendation is explained.
