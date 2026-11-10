---
description: [Recovery] Select the active platform pack (writes .spec2integration/state.json).
argument-hint: <pack-name>
allowed-tools: Read, Edit, Write, Grep, Glob
---

Set the active platform pack to `$ARGUMENTS`.

Steps:
1. If `$ARGUMENTS` is empty, list installed platform packs (any plugin whose `plugin.json` has `"integrationPlatform": "<name>"` other than `"neutral"`), and stop.
2. Verify that a plugin named `spec2integration-$ARGUMENTS` is installed. If not, instruct the user to install it via `/plugin install spec2integration-$ARGUMENTS` and stop.
3. Create `.spec2integration/` if needed and write `state.json`:

   ```json
   {
     "activePlatform": "$ARGUMENTS",
     "setAt": "<ISO-8601 now>",
     "plugin": "spec2integration-$ARGUMENTS"
   }
   ```

4. Print `Active platform pack: $ARGUMENTS` and the path to state.json.
5. Each integration's `status.json` derives `activePlatform` and stage 7 (Platform pack) from `state.json`, but the status hook does not fire for `state.json` (it is outside any integration folder). Tell the user to run `/status <folder>` for the integration in scope so its `status.json` picks up the new selection.
6. If the user supplied a pack name, read `status.json` for the target integration folder when one is in scope and ask one short follow-up question in chat: `What do you want to do next?`
  - If the chat surface supports selectable options, offer them as choices.
  - Otherwise render a numbered list and wait for the user's reply.
  - Print `Why: <next.reason>` before the choices.
  - Offer these choices:
    - `Run recommended step: <next.command>`
    - `Switch to guided mode: /run-pipeline --folder <folder>`
    - `Stop here`
