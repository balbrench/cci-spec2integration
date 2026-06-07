---
description: [Manual] Catalog every BizTalk artifact in a solution folder via the biztalk-inventory agent. Produces specs/biztalk/biztalk-inventory.md and specs/biztalk/integration-catalogue.md.
argument-hint: <path-to-biztalk-solution-folder>
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Invoke the `biztalk-inventory` agent on the BizTalk solution folder at `$ARGUMENTS`.

Steps:
1. If `$ARGUMENTS` is empty or the path does not resolve to a directory, stop and ask the user for the BizTalk solution folder path.
2. Check that the folder contains at least one `.btproj` file. If not, stop with: "No `.btproj` file found in `$ARGUMENTS`. Please supply the root of a BizTalk solution or application folder."
3. Call the `biztalk-inventory` agent and pass the folder path.
4. **Verify both outputs exist** — this is a hard gate (Step 9 of the agent is required, not optional):
   - `specs/biztalk/biztalk-inventory.md`
   - `specs/biztalk/integration-catalogue.md`
   If either is missing, re-invoke the agent with the explicit instruction: "Your previous run did not produce `specs/biztalk/integration-catalogue.md`. Re-read your agent file at `.claude/agents/biztalk-inventory.md` Step 9 and Diagram Rules, then produce the catalogue from the existing inventory using `templates/biztalk/integration-catalogue.md` as the skeleton. Do not regenerate the inventory."
   If still missing after the second attempt, stop with: "biztalk-inventory failed to produce the integration catalogue. The catalogue is required by downstream agents (it provides INT-NNN tags used by every IR artifact). Inspect the agent output and re-run."
5. Print the paths to `specs/biztalk/biztalk-inventory.md` and `specs/biztalk/integration-catalogue.md`, and the summary the agent returned.
6. **Surface the next step prominently** — `/biztalk-inventory` is only the first step. The catalogue groups the solution into `INT-NNN` integration boundaries that migrate **independently** — one group → one integration. Print, as the first line of the wrap-up:

   ```
   Next: migrate one integration group at a time. Either click the ▶ Migrate action on a group (INT-NNN) in the Spec2Integration panel, or run:
     /run-pipeline --mode biztalk --input $ARGUMENTS --group INT-NNN --unattended
   Each group becomes its own integration under specs/biztalk/NNN-<group>/. To migrate the whole solution into one combined integration instead, run /biztalk-reverse-engineer $ARGUMENTS.
   ```

   Then add the review reminder underneath: "Review `specs/biztalk/biztalk-inventory.md` and `specs/biztalk/integration-catalogue.md` first — pay attention to any `manual` complexity items, as these will require human implementation."
7. Ask one short follow-up question in chat: `What do you want to do next?`
   - If the chat surface supports selectable options, offer them as choices. Otherwise render a numbered list and wait for the user's reply.
   - Offer these choices:
     - `Migrate one group (recommended)` — then read the `INT-NNN` rows from `specs/biztalk/integration-catalogue.md`, list them, and ask which group to migrate (accept an `INT-NNN` reply, or a ▶ Migrate click in the panel). For the chosen group, run `/run-pipeline --mode biztalk --input $ARGUMENTS --group <INT-NNN> --unattended`. Each group becomes its own independent integration; re-run for the next group.
     - `Migrate the whole solution at once` — run `/biztalk-reverse-engineer $ARGUMENTS` (every group collapses into one combined integration).
     - `Review the inventory and catalogue first`
     - `Stop here`
8. The inventory is shared across all BizTalk-derived integrations and is not itself a per-folder artifact. Skip the `status.json` refresh here — `/biztalk-reverse-engineer` (which produces the per-integration folder) handles it. If the user has already run `/biztalk-reverse-engineer` previously, refresh `status.json` for every `specs/biztalk/NNN-<slug>/` folder so stages 0a (Inventory) and 0b (Catalogue) reflect the updated counts.
