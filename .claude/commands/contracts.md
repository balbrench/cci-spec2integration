---
description: [Manual] Produce OpenAPI, AsyncAPI, and JSON Schema contracts via the contract-designer agent.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Steps:
1. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md` (explicit argument → active integration → sole candidate → ask), then **pin** the resolved folder as `activeIntegration` in `.spec2integration/state.json`.
2. Require `data-model.md` to exist. If not, instruct the user to run `/model` first.
3. Call the `contract-designer` agent with the folder path.
4. Call the `contract-linter` agent with the integration folder path as a final validation step. If it returns `BLOCKED`, print its Sev-1 findings — contracts must pass linting before the pipeline continues.
5. Print counts of generated files in `contracts/` and `contracts/schemas/`, plus the lint verdict. Also print this note verbatim:

   ```
   NOTE: contracts/ files are upstream sources for mappings/ and integration-ir.yaml.
   Editing any file under contracts/ (openapi.yaml, asyncapi.yaml, schemas/) makes
   those downstream stages stale. `/status <folder>` will flag them; resume with
   `/run-pipeline --folder <folder>`.
   ```
6. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 3 (Contracts) as `done`; mark stage 3a (Contracts lint) as `done` only if the lint verdict was PASS.
7. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Print `Why: <next.reason>` before the choices.
	- Offer these choices:
	  - `Run recommended step: <next.command>`
	  - `Fix contract-lint-report.md, then re-run /contracts <folder>`
	  - `Stop here`
