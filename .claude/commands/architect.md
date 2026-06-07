---
description: [Manual] Produce the vendor-neutral integration-ir.yaml via the integration-architect agent.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Invoke the `integration-architect` agent.

Steps:
1. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md` (explicit argument → active integration → sole candidate → ask), then **pin** the resolved folder as `activeIntegration` in `.spec2integration/state.json`.
2. Require `contracts/openapi.yaml`, `contracts/asyncapi.yaml`, and at least one schema in `contracts/schemas/` to exist. If any are missing, instruct the user to run `/contracts` first.
3. Call the `integration-architect` agent with the folder path.
4. After the agent writes `integration-ir.yaml`, validate it against `schemas/integration-ir.schema.json`. If invalid, report errors and stop without further action.
5. Print counts of channels, messages, flows, and the list of EIP node types used. Also print this note verbatim:

   ```
   NOTE: integration-ir.yaml is the input to every platform pack. Editing it directly
   (rather than re-running this command after upstream changes) makes plan.md,
   tasks.md, and the generated app/ + tests-mstest/ stale. Run `/status <folder>` to
   see what needs rebuilding.
   ```
6. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 5 (IR) as `done` with summary `<flows> flows, <channels> channels, <mappings> mappings, <deps> dependencies, <blocked> BLOCKED`.
7. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Print `Why: <next.reason>` before the choices.
	- Offer these choices:
	  - `Run recommended step: <next.command>`
	  - `Visualize flows: /visualize <folder>` (renders the IR as a Mermaid diagram into docs/generated/flows.md — recommended for any IR with more than two flows)
	  - `Advanced checks: /test-mappings <folder>`
	  - `Advanced checks: /test-flows <folder> if any flow declares tests[]`
	  - `Stop here`
