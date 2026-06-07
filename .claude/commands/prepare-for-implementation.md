---
description: [Guided] Prepare an integration for implementation by chaining /platform, /review, /plan, and /tasks.
argument-hint: [spec-folder] [--platform <pack>] [--allow-sev2]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Prepare an integration for platform-specific implementation without making the user run the pre-implementation prompts one by one.

This prompt is a **meta-runner** for the preparation slice of the pipeline. It invokes the existing slash-commands in sequence and relies on them to refresh `<folder>/status.json`. It MUST NOT write `status.json` directly.

## Arguments

Parse `$ARGUMENTS` as:

- optional integration folder path
- optional `--platform <pack>` flag; default `azure`
- optional `--allow-sev2` flag; forwarded to `/review` and `/plan`

If the folder cannot be resolved, stop with: `No integration folder found. Run /specify or pass a specs/<domain>/NNN-<slug> folder.`

## Steps

1. Resolve the integration folder.
   - If `$ARGUMENTS` contains a directory, use it.
   - Else resolve the most recently modified `specs/*/*/` folder containing `spec.md`.

2. Resolve the platform pack.
   - If `--platform <pack>` was supplied, use that value.
   - Else if `.spec2integration/state.json` already names an active platform, keep it.
   - Else default to `azure`.

3. Run `/platform <pack>` when either:
   - `.spec2integration/state.json` is missing, or
   - the active platform does not match the requested pack.
   - If `/platform` fails, surface its error and add: `Need a quick reminder after fixing it? Run /next <folder>.`

4. Run `/review <folder> [--allow-sev2]`.
   - If review reports any Sev-1 findings, stop and print the same recovery guidance as `/review`, then add: `Need a quick reminder after the fix? Run /next <folder>.`
   - If review reports Sev-2 findings and `--allow-sev2` is not set, stop and tell the user to fix them or re-run `/prepare-for-implementation <folder> --allow-sev2`, then add: `Need a quick reminder after the decision? Run /next <folder>.`

5. Run `/plan <folder> [--allow-sev2]`.
   - If `plan-blocked.md` is produced, stop and tell the user to fix the listed gates, then re-run `/prepare-for-implementation <folder>`. After that primary recovery command, add: `Need a quick reminder after the fix? Run /next <folder>.`

6. Run `/tasks <folder>`.

7. Read the refreshed `<folder>/status.json` and print a compact summary:
   - active platform
   - review counts (`sev1`, `sev2`, `sev3`)
   - whether `plan.md` and `tasks.md` now exist

8. End by asking one short follow-up question in chat: `What do you want to do next?`
   - If the chat surface supports selectable options, offer them as choices.
   - Otherwise render a numbered list and wait for the user's reply.
   - Print `Why: <next.reason>` before the choices.
   - Offer these choices:
     - `Run recommended step: <next.command>`
     - `Show quick orientation: /next <folder>`
     - `Use manual control: /review <folder>`, `/plan <folder>`, or `/tasks <folder>`
     - `Stop here`

## Notes

- This prompt is intended for greenfield and post-IR manual navigation.
- It does not replace `/run-pipeline`; it shortens the path from validated IR to implementation readiness.
- It MUST NOT invoke `/implement-<platform>` or `/deploy-<platform>`.
- It MUST NOT write `status.json` directly; only the invoked sub-prompts do that.