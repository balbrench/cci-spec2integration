---
name: lifecycle-guard
description: The freeze model that protects a post-implementation integration from destructive regeneration. Defines the `lifecycle` marker and per-stage `frozen` flag in `status.json`, the guard check every generative command runs, and the redirect table pointing at the maintenance-phase edit path (`/change`). Consumed by `/specify`, `/model`, `/contracts`, `/map`, `/architect`, `/implement-<plat>`, `/run-pipeline`, `/prepare-for-implementation`, and set by `/lifecycle`.
---

# lifecycle-guard skill

The pipeline is excellent at **greenfield generation** — PRD to deployed artifacts in one forward pass. But an integration does not stay in that phase. Once its platform artifacts are deployed and validated, the generated files (ADF JSON, workflow.json, SQL, Bicep, connections) become the **source of truth**, and every change is a *targeted edit*, not a regeneration. Re-running a generative command in that phase silently overwrites live, validated work — the single highest-severity failure mode this framework has.

This skill makes that phase a **first-class, enforced concept** instead of a prose warning in a project's `CLAUDE.md`.

## The two lifecycles

`status.json` carries a top-level `lifecycle` field:

| `lifecycle` | Meaning | Generative commands |
|---|---|---|
| `generate` (default, or absent) | The integration is still being built forward. Regeneration is expected and safe. | Run normally. |
| `post-implementation` | Artifacts are deployed/validated and are now the source of truth. The spec, IR, and contracts are **reference documents** that describe intent, not the current code. | **Refuse** — redirect to `/change`. |

A finer grain is available: each row in `stages[]` may carry `"frozen": true`. A generative command that owns a frozen stage refuses even when the top-level `lifecycle` is still `generate`. Use this to freeze a single deployed stage (e.g. stage 10 Implement) while the rest of the pipeline is still moving.

Both fields are **derived control state**, not pipeline-global mutable state — they live in the per-integration `status.json` alongside `artifactHashes` and `lastImplement`, so they do not violate Article VIII. See the reviewer's Article VIII note.

## Which commands are guarded

These commands regenerate a primary artifact (or orchestrate a chain that does) and MUST run the guard:

| Command | Stage(s) it owns | Artifact it would overwrite |
|---|---|---|
| `/specify` | 1 | `spec.md` |
| `/model` | 2 | `data-model.md` |
| `/contracts` | 3, 3a | `contracts/**` |
| `/map` | 4 | `mappings/**` + IR `mappings:` block |
| `/architect` | 5 | `integration-ir.yaml` |
| `/implement-<plat>` | 10 | the entire platform artifact tree (`app/`, `adf/`, `sql/`, `infra/`, …) |
| `/run-pipeline` | all of the above | everything from spec to platform artifacts |
| `/prepare-for-implementation` | 8, 9 (and re-runs review/plan/tasks) | `plan.md`, `tasks.md` |

`/clarify`, `/plan`, `/tasks` fold into or derive from the above; they are **not** separately guarded, but `/run-pipeline` and `/prepare-for-implementation` cover them when run as a chain.

Read-only commands (`/status`, `/next`, `/visualize`, `/ir-diff`, `/drift-check`, `/analyze`, `/idd`) and the maintenance command `/change` are **never** guarded — they never regenerate.

## The guard check (run this near the top of a guarded command)

After resolving the integration folder, **before invoking any agent**:

1. Read `<folder>/status.json`. If it does not exist, or has no `lifecycle` key and no frozen stages, the folder is in `generate` — **continue normally**.
2. The guard trips when **either**:
   - top-level `lifecycle == "post-implementation"`, **or**
   - any stage this command owns (per the table above) has `"frozen": true`.
3. If the guard trips and `--force-regen` is **not** present in the arguments, **STOP** and print the redirect block below. Do not invoke any agent, do not write any artifact.
4. If `--force-regen` **is** present, print the one-line override warning, then continue. (The override is deliberate and loud; it does not clear the freeze — the next run without `--force-regen` is guarded again.)

### Redirect block (print verbatim, filling the `<…>`)

```
This integration is in the post-implementation lifecycle — its generated artifacts
are the source of truth, and <command> would regenerate <artifact>, overwriting
live-validated work.

To make a change, do one of:
  • /change "<what you want to change>" <folder>   — targeted delta via the right
    platform agent (recommended; records a decision in decisions.md)
  • edit the specific artifact directly, then run /drift-check <folder>
  • if you REALLY intend a full regeneration (rare — you will lose hand-tuned,
    deployed artifacts): re-run with --force-regen, ideally after /lifecycle unfreeze <folder>

Why this is blocked: <next.reason-or-"artifacts are deployed and validated">.
```

### Override warning (print when `--force-regen` is set)

```
⚠ --force-regen: regenerating a post-implementation integration. Deployed artifacts
under <folder> will be overwritten from the spec/IR. This is the destructive path.
```

## Setting and clearing the lifecycle

`/lifecycle` is the only command that writes the `lifecycle` field and the `stages[].frozen` flags:

- `/lifecycle freeze <folder>` — set `lifecycle: post-implementation` and `frozen: true` on the generative stages (1, 2, 3, 3a, 4, 5, 8, 9, 10). Use after an integration is deployed and validated.
- `/lifecycle unfreeze <folder>` — set `lifecycle: generate` and clear every `frozen` flag. Re-enables destructive regeneration; print a warning.
- `/lifecycle <folder>` (no verb) — show the current lifecycle and the list of frozen stages.
- `/lifecycle freeze <folder> --stage 10` — freeze only the named stage(s).

The background `refresh-status.ps1` hook and every agent/command refresh **MUST preserve** the top-level `lifecycle` key and each `stages[].frozen` flag — exactly as they preserve `artifactHashes` and `lastImplement`. A refresh that recomputes a stage row keeps that row's `frozen` flag unless `/lifecycle` explicitly changes it.

## status.json fields this skill adds

```json
{
  "lifecycle": "generate | post-implementation",
  "stages": [
    { "id": "10", "name": "Implement", "status": "done", "frozen": true, "summary": "…" }
  ]
}
```

`lifecycle` absent is read as `generate`. `frozen` absent on a stage is read as `false`.
