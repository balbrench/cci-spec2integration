---
description: [Manual] Turn a PRD into a rigorous spec.md — or, on a re-run, update an existing spec.md in place from a changed PRD or a direct instruction — via the requirements-analyst agent.
argument-hint: <path-to-PRD | "new requirement / message detail"> [--fresh]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Invoke the `requirements-analyst` agent. **First run** creates a fresh `spec.md` from a PRD. **Re-running against an existing spec updates it in place** — the agent folds your delta (a changed PRD, or a direct instruction like "add an NFR for 5s p95 latency" or "the inbound message also carries a `customerTier` field") into the existing `spec.md`, preserving prior content and hand-edits, and never creates a duplicate `NNN` folder. Pass `--fresh` to force a brand-new integration spec instead.

Steps:
1. Parse flags from `$ARGUMENTS`: recognise `--fresh` (force a new spec) and strip it before reading the rest of the argument.
2. **Identify any existing spec in scope** (the enrich target): the active integration (`activeIntegration` in `.spec2integration/state.json`), else the folder named by the argument if it is an existing integration folder, else the sole existing `specs/*/*/` integration folder that contains a `spec.md`. Call this the EXISTING SPEC (may be none).
3. **Choose the mode:**
   - **Fresh** — if `--fresh` was passed OR there is no EXISTING SPEC. Go to step 4.
   - **Also Fresh (cross-integration guard)** — if an EXISTING SPEC is in scope AND the flag-stripped argument is a path to a `.md` file AND that file differs from the EXISTING SPEC's original source PRD (i.e. it is not a sub-path of the EXISTING SPEC's folder). In this case the user is pointing at a brand-new PRD while a different integration is active. Treat as Fresh and print: `"Argument is a new PRD file (not the active integration's source). Creating a new integration instead of enriching the existing one. Pass --fresh explicitly or use /use <folder> to pin a different active integration."` Go to step 4.
   - **Enrich** — otherwise (an EXISTING SPEC is in scope, no `--fresh`, and no cross-integration signal). Go to step 5.
4. **Fresh mode.** Resolve the PRD path: if the flag-stripped argument is a path to an existing file, use it; else check `specs/PRD.md`; else ask the user for the PRD path. If a resolved PRD path does not resolve to a file, stop and ask for a valid one.
   - **BizTalk redirect:** if the resolved path is a *directory* that contains `.btproj` or `.msi` files (a BizTalk solution/application folder, not a PRD), do not run `/specify`. Stop and tell the user: "This looks like a BizTalk source folder. For migrations use `/biztalk-reverse-engineer <folder>` instead — it reverse-engineers spec.md, contracts/, and integration-ir.yaml directly, then rejoins the pipeline at `/model`." See [docs/biztalk-pipeline.md](../../docs/biztalk-pipeline.md).
   - Call the `requirements-analyst` agent with the PRD path to create a fresh spec at the next free `NNN`. Pin the new folder as `activeIntegration`. Go to step 6.
5. **Enrich mode.** The flag-stripped argument is the **delta**. Tell the user: `Updating <EXISTING SPEC>/spec.md in place (pass --fresh to create a new integration instead).` Then call the `requirements-analyst` agent in enrich mode, passing the EXISTING SPEC folder as the target and:
   - if the argument is empty or a path to the PRD file → instruct it to **reconcile the spec against the current PRD** (add anything the PRD now states that the spec doesn't yet reflect);
   - if the argument is free text → pass it as a **direct instruction** to fold in (new FR/NFR, more message detail, or a correction), citing `[source: /specify instruction]`.
   Pin the EXISTING SPEC folder as `activeIntegration`. Go to step 6.
6. When it finishes, print the path to `<folder>/spec.md` and the agent's summary (a fresh run reports the new spec; an enrich run reports requirements added/updated and open questions added/resolved). Also print this note verbatim so users know how to revise it later:

   ```
   NOTE: spec.md is the upstream source for every later stage. If you edit it after
   data-model.md, contracts/, mappings/, integration-ir.yaml, plan.md, or tasks.md
   exist, those artifacts become stale. Run `/status <folder>` to see which stages
   need rebuilding, or `/run-pipeline --folder <folder>` to resume from the first
   stale stage.
   ```
7. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 1 (Spec) as `done` with summary `spec.md (<FR-count> FRs, <NFR-count> NFRs, <OQ-count> OQs open)`. Set `next.command` to `/clarify <folder>` if OQs > 0, else `/model <folder>`.
8. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
	- If the chat surface supports selectable options, offer them as choices.
	- Otherwise render a numbered list and wait for the user's reply.
	- Always include these choices:
	  - `Run recommended step: <next.command>`
	  - `Switch to guided mode: /run-pipeline --mode greenfield --folder <folder>`
	  - `Stop here`
	- Also print `Why: <next.reason>` before the choices so the recommendation is explained.
