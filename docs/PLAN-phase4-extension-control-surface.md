# Plan: VS Code extension control surface

**Status:** Plan for review (not yet implemented)
**Date:** 2026-10-21
**Audience:** Engineers working on `tools/vscode-extension` (TypeScript) and the pipeline hooks
**Builds on:** the lifecycle model merged in PR #16 (`lifecycle` / `frozen` in `status.json`, `/change`), the `status.json` staleness model, and [PLAN-phase3-roundtrip-and-spec-quality.md](PLAN-phase3-roundtrip-and-spec-quality.md) (Change 0 there fixes the extension's command catalog).

## Purpose

Most framework changes are markdown, agent, skill, or script work. **This plan is TypeScript engineering inside `tools/vscode-extension`**, plus one shared data file, one pipeline hook, and one small command flag. It turns the extension from a passive IR visualizer into a **control surface** for the pipeline:

- see which stages an edit made stale, as a graph, and re-run them;
- checkpoint a stage run and revert it with one click;
- review and approve edits to a deployed integration.

Together these reduce the risk of the regeneration failure mode that the lifecycle guard addresses from the command side.

| # | Change | Effort |
|---|---|---|
| 0 | **Prerequisite:** one shared stage-dependency map, plus a test harness for the extension | S |
| 1 | **Stale-stage graph panel with per-stage re-run** | M |
| 2 | **Per-stage checkpoint and one-click revert** | M |
| 3 | **Review gate for edits to a deployed integration** | S, or M with the pre-write hook |

**How this differs from Claude Code's own checkpoints.** Claude Code can already rewind file edits made inside a session (`/rewind`). This plan adds what that doesn't cover: revert points labelled by **pipeline stage**, kept **across sessions** on the stage row, scoped to one integration folder, and covering files written by any means, including shell commands.

## The governing constraint — the extension is prompt-driven

This one fact shapes every change below. Per [`src/chatBridge.ts`](../tools/vscode-extension/src/chatBridge.ts), the extension **assembles a slash command and hands it to the live Claude Code chat**, trying Claude Code's internal open command, then the `vscode://anthropic.claude-code/open` deep link, then the clipboard. It does **not**:

- spawn a headless `claude -p` run it can wait on,
- inject into an already-open Claude session,
- intercept or gate an agent's `Write` / `Edit` tool calls. Those happen inside Claude Code, which has its own edit-approval UI the extension cannot see.

What the extension **can** do:
- read the workspace filesystem and `<folder>/status.json`;
- run `git` on the workspace;
- render webviews (like `src/visualizer.ts` and `src/progress.ts`);
- contribute tree views and commands (`src/tree.ts`);
- dispatch slash commands through `chatBridge`.

It learns that a stage finished by watching `status.json` change. The `PostToolUse` hook `scripts/refresh-status.ps1` rewrites that file after any edit, and `src/extension.ts` already watches `**/specs/**/status.json`.

**Consequence:** checkpoint/revert and review must be **git- and filesystem-based in the extension**, taken *around* a dispatched command: snapshot before dispatch, then diff or revert after `status.json` signals completion. A true *pre-write* gate needs a **`PreToolUse` hook** at the pipeline layer, not extension code. Each change below states which mechanism it uses.

## Existing building blocks (reuse, don't rebuild)

| Asset | File | Reused by |
|---|---|---|
| Pipeline tree with stage rows and the `runStage` / `runNext` commands | `src/tree.ts`, `src/extension.ts`, `package.json` | 1, 2 |
| Webview pattern: a pre-built HTML page in `media/visualizer/`, loaded with `asWebviewUri` | `src/visualizer.ts` | 1 |
| Progress cockpit webview and `status.json` reads | `src/progress.ts`, `src/discovery.ts` | 1, 2 |
| `status.json` file watcher | `src/extension.ts` | 1, 2, 3 |
| Command dispatch to chat | `src/chatBridge.ts` | 1, 2, 3 |
| `staleness[]`, `lifecycle`, and `frozen` fields | `pipeline-status` and `lifecycle-guard` skills; `scripts/refresh-status.ps1` | 1, 3 |
| `PostToolUse` hook wiring | `.claude/settings.json` `hooks` block | 3 (adds a `PreToolUse` sibling) |

---

## Change 0 — Shared dependency map and test harness (prerequisite)

### Shared stage-dependency map

**Problem.** The stage dependency map (which artifact each stage produces, and which upstream files make it stale) is written out twice today:
- in prose in the `pipeline-status` skill;
- as a hash table in [`scripts/refresh-status.ps1`](../scripts/refresh-status.ps1) (around line 630).

The graph panel would add a third copy in TypeScript. Three hand-maintained copies will drift apart.

**Change.** Put the map in one data file, `schemas/stage-dependencies.json`: each stage id with its name, its producing slash command, its artifact path(s), and its upstream path(s).

| File | Change |
|---|---|
| `schemas/stage-dependencies.json` | **New.** The single source of the map. `sync-assets.js` already copies `schemas/` into the extension bundle, and scaffolding copies it into new workspaces, so no packaging change is needed. |
| `scripts/refresh-status.ps1` | Read the map from the JSON (`ConvertFrom-Json`) instead of the inline hash table. Behaviour must stay identical. |
| `.claude/skills/pipeline-status/SKILL.md` | Point the **Staleness** section at the JSON as the source of truth. Keep a short human-readable summary. |
| `src/stageMap.ts` | **New.** Load and type the map: from the workspace's `schemas/` when present, otherwise from the bundled `assets/schemas/`. |

**Testing.** Run `refresh-status.ps1` on the same test folder before and after the change and confirm the resulting `status.json` is identical, ignoring `generatedAt`.

### Test harness

The extension has no automated tests today: no `test` script and no test folder. Change 2's revert is destructive, so it needs real tests.

- Add a `test` script using Node's built-in runner (`node --test`), with no new dependencies.
- Keep the git and graph logic in modules that **don't import `vscode`** (`checkpointCore.ts`, `stageGraphModel.ts`) so they can be tested in plain Node. The `vscode`-facing code stays a thin layer over them.
- Tests create a temporary git repository, run checkpoint/revert against it, and assert on the resulting files.

---

## Change 1 — Stale-stage graph panel with per-stage re-run

### Problem

The `status.json` staleness model already knows which stages are stale and why (an upstream file was edited after the downstream artifact), and the hook repoints `next` accordingly. But this only shows up as flat tree rows and a one-line `next`. A dependency **graph** where stale stages are highlighted, with a re-run button on each node, makes "what did my edit invalidate?" obvious at a glance.

### Design

- **Data:** the stage rows, `staleness[]` and `next` from `<folder>/status.json`, plus the edges from the Change 0 map. Nodes come from the `status.json` stage rows, including sub-stages such as 1a, 3a, 5a–5e and 6a, rather than from a hard-coded list. No new computation: this visualizes data the pipeline already produces.
- **Render:** a webview that follows the visualizer pattern: a pre-built page in `media/stage-graph/`, loaded with `asWebviewUri`. Node states:

  | State | Style |
  |---|---|
  | `done` | solid |
  | `missing` | outline |
  | `blocked` | red |
  | `stale` | amber |
  | `frozen` | lock badge |

  Edges show upstream→downstream dependencies; an edge whose upstream is newer is highlighted. Use a simple layered layout, since this is a DAG of about 20 nodes.
- **Per-node actions:**
  - **Re-run this stage** dispatches the stage's producing command (from the map) through `chatBridge`.
  - On a frozen node the button is disabled, with a tooltip pointing at `/change`, consistent with the lifecycle guard.
  - **Re-run from here** needs a small pipeline change. `/run-pipeline` today only accepts `--folder` and always resumes from the first stale or missing stage, so add a `--from <stageId>` flag to `.claude/commands/run-pipeline.md` that starts the resume at the given stage. Ship this action only together with that flag.
- **Entry point:** a `spec2integration.openStageGraph` command and a tree toolbar icon, next to the existing "Open IR Visualizer".

### Files

| File | Change |
|---|---|
| `src/stageGraphModel.ts` | **New, no `vscode` import.** Builds nodes and edges from `status.json` and the stage map. Unit-tested. |
| `src/stageGraph.ts` | **New.** Webview host: watches `status.json`, posts the model to the webview, routes "re-run" messages to the existing stage-dispatch path. |
| `media/stage-graph/` | **New.** Webview HTML, CSS and JS. |
| `src/tree.ts`, `src/extension.ts`, `package.json` | Register `spec2integration.openStageGraph` and add the toolbar icon. |
| `.claude/commands/run-pipeline.md` | Add the `--from <stageId>` flag (only needed for "Re-run from here"). |

### Testing

- Unit: the graph model marks the right nodes stale for a given `staleness[]`.
- Manual: edit `spec.md` after the IR exists, then open the panel. Confirm the IR node and everything downstream show as stale and name `spec.md` as the cause, and that "Re-run this stage" dispatches `/architect`.
- On a frozen integration, confirm the lock badges and disabled buttons that point at `/change`.
- Confirm the panel repaints when `status.json` changes.

### Risks

Low. It is a read-only view over existing data. The dependency-map drift risk is removed by Change 0.

---

## Change 2 — Per-stage checkpoint and one-click revert

### Problem

A bad `/architect` or `/implement-azure` run can overwrite good artifacts. The lifecycle guard stops regeneration of a *frozen* integration, but during active development (`lifecycle: generate`) there is no undo except git by hand. We want a visible, one-click "revert this stage's run".

### Design

**Snapshot before dispatch.** When the user runs a stage from the tree (`runStage`, `runNext`, or a graph node), the extension first checkpoints the integration folder. The snapshot must capture **untracked files**, because most artifacts a run creates are new files. `git stash create` does not capture them, so it is not used. Instead:

1. **Git workspaces.** Write the folder's current state through a temporary index:
   - `GIT_INDEX_FILE=<tmp> git add -A -- <folder>`
   - `git write-tree`
   - `git commit-tree`
   - store the commit under `refs/spec2integration/checkpoints/<folder-slug>/<stageId>/<timestamp>`.

   This captures tracked and untracked files without touching the user's index, `HEAD`, or stashes.
2. **Gitignored files inside the folder** (for example `app/local.settings.json` and `app/appsettings.*.json`) are invisible to git. Copy them into the checkpoint's folder in the extension's storage, excluding build output (`bin/`, `obj/`, `node_modules/`, `.azurite/`).
3. **Non-git workspaces.** Copy the whole folder, excluding build output, into the extension's storage.

**Where checkpoint data lives.** The checkpoint index (`{ stageId, command, timestamp, ref, fileList }`) and any copied files live in **VS Code's per-workspace extension storage** (`context.storageUri`), not in the repo. Article VIII says the only mutable pipeline state is `.spec2integration/state.json`; checkpoints are the extension's own state, so they stay out of the pipeline's folders. The git refs are local and are not pushed by a normal `git push`.

**Detect completion.** When `status.json` changes after the dispatched run, compute the files changed since the checkpoint and show "N files changed by this run" on the stage row. Because completion is only inferred, also offer a manual **"Compare with last checkpoint"** action.

**Revert.** A tree action **"Revert this stage's run"**:
1. Shows a confirm dialog listing the files that will be **restored** and the files that will be **deleted**: files that exist now but are not in the snapshot, i.e. created by the run.
2. Restores the snapshot into the working tree only (`git restore --source=<ref> --worktree -- <folder>`), leaving the user's staged changes alone.
3. Deletes the files that are not in the snapshot.
4. Copies back the gitignored files from storage.
5. Sets every restored file's modification time to one shared timestamp (see Risks).

`status.json` sits inside the folder, so it is restored to its pre-run state along with everything else.

**Retention.** Keep the last *N* checkpoints per stage (setting `spec2integration.checkpoints.keep`, default 5) and prune older refs and storage copies.

### Files

| File | Change |
|---|---|
| `src/checkpointCore.ts` | **New, no `vscode` import.** Snapshot (temporary-index commit + ignored-file copy), list, diff, revert (restore + delete extras + mtime normalisation), and prune. Unit-tested against temporary git repos. |
| `src/checkpoints.ts` | **New.** The `vscode` layer: storage location, confirm dialogs, and hooking the snapshot into the `runStage` / `runNext` dispatch path. |
| `src/tree.ts` | "Revert this stage's run", "Compare with last checkpoint" and "Checkpoint history" actions; "N files changed / last checkpoint" on stage rows. |
| `src/extension.ts`, `package.json` | Register `spec2integration.revertStage`, `spec2integration.compareCheckpoint` and `spec2integration.showCheckpoints`; add the settings `spec2integration.checkpoints.enabled` and `spec2integration.checkpoints.keep`. |

### Testing

Unit tests (`checkpointCore`, temporary git repo):
- A run that **adds** files, then a revert, leaves the folder byte-identical to the snapshot, with the added files gone.
- A run that **modifies and deletes** files, then a revert, restores them.
- **Gitignored** files are restored from storage.
- The user's **staged changes and `HEAD`** are unchanged by snapshot and revert.
- Files **outside** the integration folder are never touched.
- The **non-git** path round-trips.

Manual: run `/implement-azure` from the tree, confirm the checkpoint and the "N files changed" count, revert, and confirm the folder and `status.json` are back to the pre-run state.

### Risks

- **Completion is inferred.** The extension gets no callback when a chat run finishes; it relies on `status.json` changing. A run that edits files without triggering a refresh leaves the count stale. The manual "Compare with last checkpoint" action covers this.
- **False staleness after revert.** Git does not preserve modification times, and the hook marks a stage stale when an upstream file is *newer* than its artifact. Files restored a few milliseconds apart could therefore produce spurious stale flags. Setting all restored files to one shared timestamp prevents this.
- **Snapshot size.** Git objects are cheap and deduplicated. Copies of ignored files are small, and build output is excluded.

---

## Change 3 — Review gate for edits to a deployed integration

### Problem

On a deployed (frozen) integration, `/change` lets an Azure agent edit a live artifact. Today those edits land silently in the working tree; we want the user to **see a diff and approve** before trusting them. The extension cannot intercept the agent's writes (see the governing constraint), so there are two complementary mechanisms. Ship the lighter one first.

### Design A — post-edit diff review in the extension (the core)

- When files change inside a folder whose `status.json` has `lifecycle: post-implementation`, the extension raises a **"Review changes to a live integration"** notification.
- A review view lists each changed artifact with its diff, using `git diff --ignore-cr-at-eol` to suppress line-ending noise. Each file has **Approve (keep)** and **Discard** (restore from the diff base). **Approve all** clears the review.
- The diff base is the Change 2 checkpoint taken before the dispatched command, or `HEAD` when no checkpoint exists.
- **Excluded from review:** files the pipeline itself rewrites on every edit or every `/change`: `status.json`, `decisions.md`, and the generated reports (`*-report.md`, `*-report.json`). Without this, every review would be cluttered with bookkeeping.
- Design A is the **safety net for every write path**. Because it diffs the filesystem, it also catches files an agent wrote through a shell command, which a tool-call hook can miss.

### Design B — pre-write gate via a `PreToolUse` hook (optional upgrade)

- Add a `PreToolUse` hook (sibling to the existing `PostToolUse` entry in `.claude/settings.json`) with the matcher `Write|Edit|MultiEdit|NotebookEdit`. When the target path is inside a `lifecycle: post-implementation` folder and is not one of the excluded bookkeeping files, the hook returns an **`ask`** permission decision. Claude Code's `PreToolUse` contract supports `allow` / `deny` / `ask`, so Claude Code pauses for confirmation *before* the write lands.
- **Known gap: shell writes.** Writes made through `Bash` (several agents and `/change` have Bash) carry no structured target path, so the hook cannot reliably gate them. Design A catches those after the fact. State this gap in the docs rather than gating every Bash call.
- **Cross-platform.** The existing `PostToolUse` hook calls Windows `powershell`, so it runs only on Windows. Write the new hook to run under PowerShell 7 (`pwsh`), so it works on Windows, macOS and Linux, and invoke it as `pwsh`. A hook that fails to start does not block the write, so on machines without `pwsh` the gate silently disappears and Design A remains the safety net. Making the existing `PostToolUse` hook cross-platform is a separate change.

### Files

| File | Change |
|---|---|
| `src/reviewGate.ts` | **New.** Watches frozen folders for changes; the review webview; per-file approve and discard. Reuses `checkpointCore` for the diff base and discard. |
| `src/tree.ts`, `src/extension.ts`, `package.json` | Register `spec2integration.reviewChanges`; a "pending review" badge on folders with unapproved live edits; a `spec2integration.reviewGate` setting (`off` / `frozen-only` / `always`, default `frozen-only`). |
| `scripts/pretooluse-guard.ps1` | **New (Design B).** Read the target path from the hook input, find the owning integration folder, check `status.json` `lifecycle`, skip the excluded files, and emit `ask` for frozen folders. |
| `.claude/settings.json` | **(Design B)** Add the `PreToolUse` entry. Document how to opt out (remove the entry), mirroring the `PostToolUse` note in `CLAUDE.md`. |
| `CLAUDE.md` | **(Design B)** Describe the pre-write gate and its shell-write gap next to the existing hook description. |

### Testing

- **Design A:** on a frozen folder, run `/change` and confirm the review lists the edited artifact but **not** `status.json` or `decisions.md`, and that Approve and Discard behave correctly. Make an edit through a shell command and confirm Design A still catches it.
- **Design B:** confirm that an edit inside a frozen folder asks before landing, that an edit in a `generate` folder does not, and that `status.json` updates are not gated. Confirm on Windows, plus macOS or Linux if available.
- **Both:** confirm neither fires during normal greenfield (`generate`) work.

### Risks

- **Prompt fatigue (Design B):** every non-bookkeeping write in a frozen folder asks. It is scoped to frozen folders, excludes bookkeeping files, and is opt-in.
- **Diff noise:** formatter and line-ending changes. Use `--ignore-cr-at-eol` and respect `.gitattributes`.

---

## Release

This is extension code, so it ships through the tag-triggered release workflow (`.github/workflows/release-extension.yml`). For each release:
- bump `tools/vscode-extension/package.json`;
- add a `CHANGELOG.md` entry;
- update the extension `README.md` (new commands, settings, the stage graph);
- push a `v*` tag.

Changes can ship together or one release at a time.

## Sequencing

1. **Change 0:** the shared dependency map and the test harness. Everything else uses them.
2. **Change 1 (stage graph):** the highest visible value and lowest risk, because it is a read-only view.
3. **Change 2 (checkpoints):** introduces the snapshot and revert code that Change 3 reuses.
4. **Change 3 Design A** on top of Change 2; **Design B** only if a hard pre-write stop is wanted.

## Out of scope

- Injecting into or waiting on a running Claude session: not achievable from a third-party extension (see the governing constraint). All completion detection goes through `status.json`.
- Running stages headlessly: the extension stays prompt-driven and never executes commands itself.
- Changes to the generative agents. The only pipeline-side changes are the shared map, the optional `--from` flag, and the optional `PreToolUse` hook.
- Making the existing Windows-only `PostToolUse` hook cross-platform (a separate change).

## Relationship to the lifecycle model

The `lifecycle` and `frozen` fields from PR #16 drive all three changes:
- the lock badges and disabled re-run buttons in the graph (Change 1);
- the safety net behind revert (Change 2);
- when the review gate fires (Change 3).
