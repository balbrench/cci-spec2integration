---
description: [Reporting] Show or set the active integration folder that other commands default to when you omit the folder argument.
argument-hint: [spec-folder | --clear]
allowed-tools: Read, Edit, Write, Grep, Glob
---

Manage the **active integration** — the folder that commands like `/map`, `/review`, `/plan`, `/architect`, `/next` use when you don't pass a path. It is stored as `activeIntegration` in `.spec2integration/state.json`. See the **Resolving the integration folder** section of `.claude/skills/pipeline-status/SKILL.md` for how the precedence works.

Steps:

1. Parse `$ARGUMENTS`:
   - **`--clear`** (or `--unset`): remove the `activeIntegration` key from `.spec2integration/state.json` (preserve every other field and the file's existing encoding), print `Active integration cleared. Commands will fall back to sole-candidate / ask resolution.`, and stop.
   - **A folder path**: validate that it resolves to an integration folder — an existing `specs/*/*/` directory that contains `spec.md` or `integration-ir.yaml`. If it does not exist or is not an integration folder, do **not** set it: list the candidate `specs/*/*/` folders (most-recent-first) and ask the user to pick a valid one. Otherwise continue to step 2.
   - **Empty**: this is a *show* request — skip to step 3.

2. **Set.** Write the resolved **relative** folder path to `activeIntegration` in `.spec2integration/state.json` (create the file or the key if absent; preserve every other field and the file's existing encoding). Print `Active integration set to <folder>.` Then fall through to step 3 to show its current state.

3. **Show.** Read `.spec2integration/state.json`:
   - If `activeIntegration` is set, print it. If `<folder>/status.json` exists, read it and print `Stage <done>/<total>`, the `next.command`, and `next.reason`. Then ask one short follow-up: `What do you want to do next?` with choices:
     - `Run next step: <next.command>`
     - `Switch integration: /use <other-folder>`
     - `Clear: /use --clear`
     - `Stop here`
   - If `activeIntegration` is **not** set, list the candidate `specs/*/*/` folders (most-recent-first, with last-modified time) and tell the user they can pin one with `/use <folder>`, or that commands will otherwise fall back to sole-candidate / ask resolution.

4. This command does **not** produce or modify any integration artifact, so it does **not** refresh `status.json`. It only reads and writes `.spec2integration/state.json` (the `activeIntegration` key). It does not invoke any agent.
