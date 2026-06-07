---
description: [Manual] Produce the platform-neutral mappings block of the IR and the per-mapping Source-to-Target (STM) documents via the mapping-designer agent.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Invoke the `mapping-designer` agent.

Steps:
1. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md` (explicit argument → active integration → sole candidate → ask), then **pin** the resolved folder as `activeIntegration` in `.spec2integration/state.json`.
2. Require `contracts/openapi.yaml`, `contracts/asyncapi.yaml`, and at least one schema under `contracts/schemas/` to exist. If any are missing, instruct the user to run `/contracts` first.
3. Call the `mapping-designer` agent with the folder path.
4. After the agent runs, verify:
   - `integration-ir.yaml` contains a non-empty `mappings:` block and passes `schemas/integration-ir.schema.json`;
   - one `mappings/<Name>.md` STM document exists for every `mappings[].name`;
   - every mapping has at least one test and both fixture files resolve on disk.
5. Print the list of mappings with their source → target → engine, and note any mapping without tests. Also print this note verbatim:

   ```
   NOTE: mappings/<Name>.md are upstream sources for integration-ir.yaml's mappings
   block. Editing an STM document (or its referenced JSONata/XSLT) makes the IR and
   downstream stages stale. Run `/status <folder>` to see what needs rebuilding.
   ```
6. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 4 (Mappings (STM)) as `done` with summary `N/N STM docs` and recompute `next`.
7. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
   - If the chat surface supports selectable options, offer them as choices.
   - Otherwise render a numbered list and wait for the user's reply.
   - Print `Why: <next.reason>` before the choices.
   - Offer these choices:
     - `Run recommended step: <next.command>`
     - `Exercise fixtures now: /test-mappings <folder>`
     - `Stop here`
