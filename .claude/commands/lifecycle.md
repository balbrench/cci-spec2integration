---
description: [Maintenance] Show, freeze, or unfreeze an integration's lifecycle — freeze protects deployed artifacts from destructive regeneration.
argument-hint: [freeze|unfreeze] [spec-folder] [--stage <id[,id...]>]
allowed-tools: Read, Edit, Write, Grep, Glob
---

Manage the **lifecycle** of an integration — the freeze model defined in `.claude/skills/lifecycle-guard/SKILL.md`. Freezing an integration marks its generated artifacts as the source of truth so the generative commands (`/specify`, `/model`, `/contracts`, `/map`, `/architect`, `/implement-<plat>`, `/run-pipeline`, `/prepare-for-implementation`) refuse to overwrite them. Use this once an integration is deployed and validated.

This command writes **only** the `lifecycle` key and the `stages[].frozen` flags in `<folder>/status.json` (preserving every other key, exactly as `/use` touches only `activeIntegration`). It invokes no agent and re-probes no stages.

## Steps

1. Parse `$ARGUMENTS`:
   - First token is the **verb**: `freeze`, `unfreeze`, or absent (= *show*).
   - A `specs/*/*/` path is the folder.
   - `--stage <id[,id,...]>` (freeze only) restricts the freeze to the named stage ids; default is the generative set `1,2,3,3a,4,5,8,9,10`.

2. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md` (explicit argument → active integration → sole candidate → ask). A write verb (`freeze`/`unfreeze`) **pins** the resolved folder as `activeIntegration`; a bare *show* only consults it.

3. Require `<folder>/status.json` to exist. If it is missing, stop with: `No status.json for <folder>. Run /status <folder> first (the pipeline must have produced artifacts before a lifecycle can be set).`

4. **Show** (no verb): read `status.json` and print:
   ```
   Lifecycle: <generate | post-implementation>   (<folder>)
   Frozen stages: <comma-separated stage ids, or "none">
   ```
   Then, if `lifecycle == post-implementation`, add: `Generative commands are blocked. Make changes with /change "<description>" <folder>.`
   Stop.

5. **freeze**: read `status.json`, set top-level `lifecycle: "post-implementation"`, and set `"frozen": true` on each stage row whose id is in the target set (default `1,2,3,3a,4,5,8,9,10`, or the `--stage` list). Preserve every other key and every other stage field. Set `refreshedBy: "/lifecycle"` and `generatedAt` to now. Write it back. Print:
   ```
   Froze <folder>. Lifecycle = post-implementation; frozen stages: <ids>.
   Generative commands will now refuse to regenerate. Edit via /change "<description>" <folder>,
   or override a single run with --force-regen.
   ```

6. **unfreeze**: read `status.json`, set `lifecycle: "generate"`, remove `frozen` (or set `false`) on every stage row. Preserve every other key. Set `refreshedBy`/`generatedAt`. Write it back. Print:
   ```
   ⚠ Unfroze <folder>. Lifecycle = generate. Generative commands can now regenerate and
   OVERWRITE deployed artifacts. Re-freeze with /lifecycle freeze <folder> when done.
   ```

7. This command does not refresh stage statuses and does not invoke any agent. The only mutation is the `lifecycle` / `frozen` keys in `status.json`.

## Examples

- Freeze a deployed integration: `/lifecycle freeze specs/orders/002-order-sync`
- Freeze only the Implement stage: `/lifecycle freeze specs/.../002-... --stage 10`
- Show current state: `/lifecycle specs/.../002-...`
- Re-open for regeneration: `/lifecycle unfreeze specs/.../002-...`
