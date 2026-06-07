---
description: [Manual] Turn a rough integration brief into a structured PRD under specs/ — or, on a re-run, enrich the existing PRD with more detail — via the prd-author agent.
argument-hint: <brief / more detail / answer> [--fresh]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Invoke the `prd-author` agent on the brief in `$ARGUMENTS`. **Re-running this command updates the same PRD** — the agent merges your new input into the existing `specs/PRD.md` and preserves prior content, so you can build the PRD up over several calls. Pass `--fresh` to throw the existing PRD away and start over.

Steps:
1. Parse flags from `$ARGUMENTS`: recognise `--fresh` (force a from-scratch rewrite) and strip it before reading the brief.
2. If the remaining `$ARGUMENTS` is empty, stop and ask the user to describe the integration (or, when a PRD already exists, what to add or change). Prefer a short structured brief covering purpose, source, destination, trigger, input format, output format, and example fields.
3. Call the `prd-author` agent, passing the brief and whether `--fresh` was set:
   - If `specs/PRD.md` (or the user-specified path) **already exists** and `--fresh` was NOT set, tell the user `Updating the existing PRD with your input (pass --fresh to rewrite from scratch).` — the agent reads the existing PRD and merges your input in, preserving prior content and any hand-edits.
   - Otherwise the agent writes a fresh PRD from the brief.
4. When it finishes, print the path to the PRD and the agent's summary (a fresh run reports the new PRD; an enrich run reports what it added, updated, and resolved).
5. Remind the user to review any `[ASSUMPTION: …]` entries and all field-level / wire-format sections before running `/specify <path-to-PRD>`. Note they can keep calling `/draft-prd "<more detail>"` to layer in information incrementally — each call updates the same PRD.
6. End by asking one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Print `Why: the PRD exists, so the next stage is requirements capture.` before the choices.
	- Offer these choices:
	  - `Run recommended step: /specify <path-to-PRD>`
	  - `Switch to guided mode: /run-pipeline --mode greenfield --input <path-to-PRD>`
	  - `Stop here`
