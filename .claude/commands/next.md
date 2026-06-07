---
description: [Reporting] Show only the next recommended pipeline command for an integration folder. Read-only shortcut over status.json.
argument-hint: [spec-folder]
allowed-tools: Read, Grep, Glob
---

Show the next recommended pipeline action for an integration folder without printing the full status table.

Steps:

1. Resolve the integration folder:
   - If `$ARGUMENTS` is provided and resolves to a directory, use it.
   - Else if `.spec2integration/state.json` has `activeIntegration` set and that folder exists, use it.
   - Else look for a single subfolder under `specs/` containing `spec.md`.
   - Else stop with: "No integration folder found. Run `/specify` (greenfield) or `/biztalk-reverse-engineer` (BizTalk) first, or pin one with `/use <folder>`."

   This is a read-only command: consult `activeIntegration` as a default but do **not** modify it.

2. Require `<folder>/status.json` to exist.
   - If it is missing, stop with: "No status.json found for <folder>. Run `/status <folder>` first to compute the next step."

3. Read `<folder>/status.json` and extract:
   - `next.command`
   - `next.reason`
   - `activePlatform`
   - `generatedAt`
   - `refreshedBy`
   - any blocking counts from `counts` (`openClarifications`, `sev1`, `blockedFlows`, `staleStages`)
   - the `staleness` array (each entry has `stage`, `stagename`, `stalerThan`, `reason`)
   - `staleness_probed` (boolean; `false` means the file was refreshed by a command without Bash access — staleness has not been checked since)

4. Print a concise next-step summary:

   ```
   === Next Step: <folder> ===
   Recommended: <next.command>
   Reason: <next.reason>
   Active platform: <activePlatform or "(none)">
   Open clarifications: <N>
   Sev-1 findings: <N or "-">
   BLOCKED flows: <N>
   Stale stages: <N>
   Last refresh: <refreshedBy> at <generatedAt>
   ```

   If `staleness` is non-empty, append (after the summary, before the follow-up question):

   ```
   Stale because:
     - Stage <id> (<stagename>): <reason>
     - ... (one line per staleness entry)
   ```

   When staleness exists, the recommendation in `next.command` already points at the producing command for the earliest stale stage — `next.reason` will explain which upstream file triggered it. Mention this explicitly: `The recommended command will rebuild <stagename> from the newer upstream.`

   If `staleness_probed` is `false`, print one extra line: `Staleness has not been probed since the last refresh by <refreshedBy>. Run /status <folder> to check whether any source artifact was edited after a later one.`

5. After the summary, ask one short follow-up question in chat: `What do you want to do next?`
    - If the chat surface supports selectable options, offer them as choices.
    - Otherwise render a numbered list and wait for the user's reply.
    - Offer these choices:
       - `Run recommended step: <next.command>`
       - `Show full status: /status <folder>`
       - When `staleness` is non-empty, additionally offer: `Resume from earliest stale stage: /run-pipeline --folder <folder>`
       - `Stop here`

6. If `next.command` starts with `/deploy-`, add one extra line:

   ```
   Pipeline is complete through tests. Deployment is the next unmet stage.
   ```

7. If `next.command` is empty or the pipeline is already complete, print:

   ```
   No next command recorded. Run `/status <folder>` to refresh derived state.
   ```

Notes:
- This prompt is read-only. It MUST NOT write `status.json` or any other artifact.
- This prompt is intentionally narrower than `/status`: it surfaces only the next action and the most relevant blocking counters.
- Do not invoke any agent.
