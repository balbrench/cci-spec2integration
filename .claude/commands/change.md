---
description: [Maintenance] Apply a targeted change to a post-implementation integration's deployed artifacts via the right platform agent — a delta, never a full regeneration. Records a decision in decisions.md.
argument-hint: "<change description>" [spec-folder] [--agent <name>] [--dry-run]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent, Bash
---

Apply a **targeted change** to an integration whose artifacts are already deployed and are the source of truth. This is the sanctioned maintenance path for a `post-implementation` (frozen) integration: instead of regenerating from the spec/IR — which `/specify`, `/architect`, `/implement-<plat>`, etc. refuse to do on a frozen folder — it reads the specific deployed artifact, routes the change to the agent that owns that artifact's format, and has the agent make the minimal edit. It then records the change as a decision and keeps the drift baseline honest.

`/change` is **never** guarded by the lifecycle-guard — making targeted edits is exactly its purpose.

## Steps

1. Parse `$ARGUMENTS`:
   - The **quoted change description** is required (e.g. `"add a contoso_title lookup column to the contact sink"`). If absent, stop with: `/change requires a quoted change description. Example: /change "widen staging email column to 320 chars" <folder>`.
   - An optional `specs/*/*/` folder.
   - `--agent <name>` — force the routing target (skip step 4's classification).
   - `--dry-run` — print the routing decision and planned edit, then stop without invoking any agent.

2. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md`, then **pin** it as `activeIntegration`.

3. Read `<folder>/status.json` to learn the `activePlatform` and (for the decision log) the current state. If `lifecycle != post-implementation`, this folder is still in forward-build mode: print a one-line note — `Note: <folder> is in the 'generate' lifecycle; the normal pipeline commands also work here. Continuing with a targeted /change anyway.` — and proceed (a targeted edit is always valid).

4. **Classify the change → pick the owning agent and target artifact(s).** Read the description and grep the folder to find the real files involved. Route by the artifact the change touches (Azure pack shown; other packs route to their equivalent agents):

   | Change touches | Agent (`subagent_type`) | Typical target files |
   |---|---|---|
   | ADF pipeline / dataset / linked service / data flow / trigger | `azure-data-factory-compiler` | `adf/**` |
   | Dynamics 365 CE / Dataverse entity write, lookup bind, alternate key, CDS linked service | `azure-dataverse-binder` | `adf/linkedServices/*Dataverse*`, `adf/dataflows/**`, entity write config |
   | SQL table / stored procedure / view / grant | `azure-sql-schema-author` | `sql/**` |
   | Bicep / `infra/` modules | `azure-bicep-author` | `infra/**`, `azure.yaml` |
   | GitHub Actions workflows | `azure-cicd-author` | `.github/workflows/**` |
   | Linked service auth / `connections.json` / app settings | `azure-connections-binder` | `app/connections.json`, `app/appsettings.*.json`, `identity-role-assignments.json` |
   | Logic Apps Standard `workflow.json` | `azure-logic-apps-compiler` | `app/<flow>/workflow.json` |
   | Stand-alone Function App code | `azure-functions-compiler` | `FunctionApps/<flow>/**` |
   | In-process Logic Apps custom code (`InvokeFunction`) | `azure-local-functions-author` | `Functions/**` |
   | MSTest workflow tests | `azure-workflow-tester` | `tests-mstest/**` |

   `--agent <name>` overrides this table. If the change is **ambiguous** (touches two+ unrelated artifact classes, or you cannot identify the files), ask the user to confirm the agent/files before proceeding — do not guess across a destructive seam.

5. **Read the existing target artifact(s) first**, so the agent edits rather than regenerates. Then invoke the owning agent via the `Agent` tool with this exact directive (the agents carry the authoritative knowledge of correct ADF/Bicep/SQL/Dataverse structure; hand-editing them is how silent bugs enter):

   > Read the existing artifact(s) at `<path(s)>`, then make this targeted change: `<description>`. Do **not** regenerate other artifacts, and do **not** re-emit files you were not asked to change — edit only the listed file(s). Preserve all surrounding structure, comments, and tokens. Do not write `status.json` (the calling command owns the refresh).

   If `--dry-run` was set, instead print: the resolved agent, the exact target file list, and the directive above — then stop.

6. After the agent returns, surface what changed (the file list + a one-line summary of each edit) and any TODOs the agent emitted.

7. **Record the decision.** Append a `DD-NN` entry to `<folder>/decisions.md` (create it from `templates/core/decisions.md` if absent — the next number is `max(existing DD-NN) + 1`):
   ```
   ### DD-NN — <one-line title derived from the change>
   - **Date:** <ISO-8601 date>
   - **Change:** <the verbatim change description>
   - **Artifacts:** <relative paths edited>
   - **Agent:** <agent used>
   - **Rationale:** <why — from the user's description or the agent's summary>
   - **Status:** applied (not yet deployed)
   ```

8. **Keep the drift baseline honest.** For every file the agent edited, recompute its SHA-256 (PowerShell `Get-FileHash -Algorithm SHA256`, or `sha256sum`) and update that path's entry in the top-level `artifactHashes` object in `<folder>/status.json`. Merge — preserve every other key, including `lifecycle`, every `stages[].frozen` flag, `lastImplement`, and the hashes of files you did **not** change. Set `refreshedBy: "/change"` and `generatedAt` to now. Do **not** flip any stage status or clear any freeze — a targeted edit does not un-freeze the integration.

9. Remind the user that the change is applied to the repo but **not deployed**: print the deploy path for the active platform (e.g. for Azure: `Deploy with /deploy-azure <folder>, or push to main to run the integration's deploy.yml (apply-sql for SQL, the data-factory publish job for ADF, azd provision (Incremental) for Bicep).`). Deployment stays a deliberate, user-run step.

10. Ask one short follow-up: `What do you want to do next?` with choices:
    - `Deploy this change (/deploy-azure <folder>)`
    - `Make another change: /change "<...>" <folder>`
    - `Verify the baseline: /drift-check <folder>`
    - `Stop here`

## Notes

- `/change` makes **additive / targeted** edits only — it never deletes live services or regenerates sibling artifacts. This mirrors the incremental-deploy discipline (Bicep Incremental mode, additive-only SQL DDL, re-importing only the ADF artifacts that changed).
- It is the counterpart to the generative pipeline: the pipeline builds the integration; `/change` maintains it after deployment.
- Every `/change` is traceable — the `decisions.md` entry plus the refreshed `artifactHashes` mean `/drift-check` and the IDD (`/idd`) both stay consistent with reality.
