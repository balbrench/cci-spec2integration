---
description: [Manual] Produce clarifications.md for the most recent spec, answer questions with demo defaults where possible, then fold resolved answers back into spec.md.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Invoke the `clarifier` agent on the integration folder, then update spec.md with the resolved answers.

Steps:
1. Parse flags from `$ARGUMENTS`: recognise `--auto-sign-off` and strip it before resolving the folder. If the remaining `$ARGUMENTS` is empty, resolve the most recently modified `specs/*/*/` folder. Otherwise use the given folder.
2. Call the `clarifier` agent with that path. It produces `clarifications.md` with all questions, each carrying a **Recommended** answer, a **Confidence** (high/medium/low), and a `Resolved` flag.
3. **Auto sign-off — only when `--auto-sign-off` was passed.** Edit `clarifications.md` in place to close every OQ still marked `Resolved: false` by accepting its **Recommended** answer: set `Resolved: true` and fill that OQ's row in the Resolution log with `Answer` = the recommended text, `Source` = `clarifications.md OQ-N (Recommended)`, `Decided by` = `/clarify --auto-sign-off (operator-accepted recommendation)`, `Date` = today (`YYYY-MM-DD`). Accept **only** the answer the clarifier already wrote — never invent one. After closing them, print a warning listing every auto-accepted OQ whose **Confidence** is `medium` or `low` so the operator can review them, e.g. `Auto-accepted 4 recommendation(s); review these lower-confidence ones before /plan: OQ-3 (low), OQ-7 (medium).` Skip this step entirely when the flag is absent.
4. Once `clarifications.md` exists, call the `requirements-analyst` agent again with the same integration folder, instructing it to update `spec.md` in-place by:
   - Replacing each resolved open question with the confirmed answer in the relevant FR, NFR, or new FR.
   - Removing resolved questions from the Open questions section.
   - Leaving only genuinely unresolvable questions (marked OPEN) in the Open questions section.
   - Adding a reference to `clarifications.md` in the front matter.
5. Print the path to `clarifications.md`, list the first five questions with their answers, and report how many open questions remain in `spec.md`.
   - If any open questions remain after this run, print the following recovery guidance verbatim (do not assume the user already knows it from `/run-pipeline`):
     ```
     <N> question(s) remain OPEN. To close them, either:
       • re-run `/clarify <folder> --auto-sign-off` to accept the clarifier's
         recommended answers automatically (fast / demo path — review any
         low-confidence ones it flags), or
       • open `<folder>/clarifications.md`, fill in the `Answer:` field for each
         OPEN question, set `Resolved: true`, and add a row to the sign-off log at
         the bottom of the file; then re-run `/clarify <folder>` to fold the
         resolved answers back into spec.md.
     Genuinely unresolvable questions can stay OPEN; `/plan` will surface them as
     phase-gate findings rather than blockers.
     ```
6. Refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Update stage 1a to `done` with summary `clarifications.md (<total> total — <closed> signed off, <open> open)`, update stage 1's summary to reflect the new OQ count, and recompute `counts.openClarifications` / `counts.closedClarifications` and the `next` recommendation.
7. Read the refreshed `<folder>/status.json` and ask one short follow-up question in chat: `What do you want to do next?`
   - If the chat surface supports selectable options, offer them as choices.
   - Otherwise render a numbered list and wait for the user's reply.
   - Always include these choices:
     - `Run recommended step: <next.command>`
     - `Finish remaining sign-offs, then re-run /clarify <folder>`
     - `Stop here`
   - Also print `Why: <next.reason>` before the choices so the recommendation is explained.
