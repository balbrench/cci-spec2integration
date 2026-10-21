# Plan: Phase 4 — VS Code extension beyond visualization

**Status:** Plan for review (not yet implemented)
**Date:** 2026-10-21
**Audience:** Engineers working on `tools/vscode-extension` (TypeScript) and the pipeline hooks
**Depends on:** Phase 1 (lifecycle guard / `frozen` flags, `/change`), Phase 2, and the `status.json` staleness model — already in this repo.

## Purpose

Phases 1–3 are markdown / agent / skill / script work — the native medium of this framework. **Phase 4 is different: it is TypeScript engineering inside `tools/vscode-extension`**, plus one pipeline hook. It turns the extension from a passive IR visualizer into a **control surface** for the pipeline: checkpoint/revert bad runs, see and re-run stale stages as a graph, and approve live-artifact edits before they land. These are the three highest-value extension upgrades the 002 build surfaced; they directly de-risk the regeneration failure mode that Phase 1's lifecycle guard addresses from the command side.

| # | Item | Effort | Public precedent |
|---|---|---|---|
| 8 | **Per-stage checkpoint and one-click revert** | M | Claude Code / Kilocode checkpoints |
| 9 | **Stale-stage DAG panel with per-stage re-run** | M | kiro-for-codex tree UI |
| 10 | **Diff-and-approve gate before live edits land** | S* | Kilocode HITL diff preview |

\* Item 10 is "S" as a git-diff surface in the extension, "M" if a true pre-write hook gate is also built (see its section).

## The governing constraint — the extension is prompt-driven

This is the single fact that shapes every item below. Per `src/chatBridge.ts`, the extension **assembles a slash command and hands it to the live Claude Code chat** (via Claude Code's internal open command → deep link → clipboard fallback). It does **not**:

- spawn a headless `claude -p` run it can await,
- inject into an already-open Claude session,
- intercept or gate an agent's `Write`/`Edit` tool calls — those happen inside Claude Code, which has its own edit-approval UI the extension cannot see.

What the extension **can** do: read the workspace filesystem and `<folder>/status.json`, run `git` on the workspace, render webviews (like `src/visualizer.ts` / `src/progress.ts`), contribute tree views and commands (`src/tree.ts`), and dispatch slash commands through `chatBridge`. It learns a stage finished by observing `status.json` being refreshed (the `PostToolUse` hook `scripts/refresh-status.ps1` rewrites it after any edit).

**Consequence:** checkpoint/revert and diff/approve must be **git- and filesystem-based in the extension**, taken *around* a dispatched command (snapshot before dispatch, diff/revert after the hook signals completion) — not as an in-session interception. A true *pre-write* gate requires a **`PreToolUse` hook** at the pipeline layer, not extension code. The plan below is honest about which mechanism each item uses.

## Existing building blocks (reuse, don't rebuild)

| Asset | File | Reused by |
|---|---|---|
| Pipeline tree with stage rows + `runStage` / `runNext` commands | `src/tree.ts`, `package.json` contributes | items 8, 9 |
| Webview pattern (IR visualizer) | `src/visualizer.ts` | item 9 (DAG panel) |
| Progress cockpit webview + `status.json` reads | `src/progress.ts`, `src/discovery.ts` | items 8, 9 |
| Command dispatch to chat | `src/chatBridge.ts` | items 8, 9, 10 |
| `status.json` staleness array + `frozen`/`lifecycle` fields | `pipeline-status` + `lifecycle-guard` skills; `scripts/refresh-status.ps1` | items 9, 10 |
| PostToolUse hook wiring | `.claude/settings.json` `hooks` block | item 10 (add a PreToolUse sibling) |

---

## Item 8 — Per-stage checkpoint and one-click revert

### Problem

A bad `/architect` or `/implement-azure` run can overwrite good artifacts. Phase 1's lifecycle guard prevents *regenerating a frozen* integration, but during active development (lifecycle `generate`) there is no undo — the user must rely on git by hand. We want a visible, one-click "revert that stage's run."

### Design (git-backed checkpoints taken around a dispatched stage)

- **Checkpoint before dispatch.** When the user runs a stage from the tree (`runStage`) or `runNext`, the extension first creates a **checkpoint** of the integration folder: a lightweight git snapshot (`git stash create` + keep, or a dedicated `refs/spec2integration/checkpoints/<folder>/<stageId>/<timestamp>` ref, or a tar snapshot under `.spec2integration/checkpoints/` for non-git workspaces). Record `{ stageId, command, timestamp, ref, changedFilesBaseline }` in a per-folder checkpoint index.
- **Detect completion.** The extension watches `<folder>/status.json` (it already does for the tree). When the hook refreshes it after the dispatched run, compute the file delta since the checkpoint (`git diff --name-only <ref>`), and attach "N files changed by this run" to the stage row.
- **Revert.** A tree context action **"Revert this stage's run"** restores the checkpoint (`git checkout <ref> -- <folder>` / stash apply / tar restore) and re-runs `/status` to refresh. Guard it with a confirm dialog listing the files that will be restored.
- **Surface.** Show the last checkpoint time + "N files changed" on each stage row; a history submenu lists recent checkpoints for that stage.

### Files

| File | Change |
|---|---|
| `src/checkpoints.ts` | **New.** Create/list/restore checkpoints; git-first with a tar fallback; the per-folder checkpoint index under `.spec2integration/checkpoints/`. |
| `src/tree.ts` | Add "Revert this stage's run" + "Checkpoint history" context actions; render "N files changed / last checkpoint" on stage rows. |
| `src/extension.ts`, `package.json` | Register `spec2integration.revertStage`, `spec2integration.showCheckpoints`; hook the checkpoint-before-dispatch into the existing `runStage`/`runNext` flow; add a `spec2integration.checkpointsEnabled` setting. |
| `.gitignore` (repo) | Ignore `.spec2integration/checkpoints/` (snapshots are local, not committed). |

### Testing

- Run a stage, confirm a checkpoint ref/snapshot is created; edit artifacts via the dispatched command; confirm "N files changed" appears; revert and confirm the folder returns to the pre-run state and `status.json` re-probes.
- Non-git workspace: confirm the tar fallback path works.
- Confirm checkpoints are scoped to the integration folder (never the whole workspace).

### Risks

- **Async completion.** The extension doesn't get a callback when the chat run finishes; it infers completion from the `status.json` refresh. A run that edits files but doesn't trigger a refresh would leave the "changed files" count stale — mitigate by also offering a manual "diff against last checkpoint" action.
- **Snapshot size** for large artifact trees — git refs are cheap; the tar fallback should exclude `node_modules`/build output.

---

## Item 9 — Stale-stage DAG panel with per-stage re-run

### Problem

The `status.json` staleness model already knows which stages are stale and why (upstream edited after downstream), and the `refresh-status.ps1` hook repoints `next` — but this is only exposed as flat tree rows and a one-line `next`. A dependency **graph** where stale stages glow, with a re-run button per node, makes "what did my edit invalidate?" obvious at a glance.

### Design (new webview, reusing visualizer plumbing + existing data)

- **Data source:** the stage list + `staleness[]` array + `next` from `<folder>/status.json`, and the **dependency map** from the `pipeline-status` skill (encode it once in TS as the edge list; it is the same map the hook uses). No new computation — this is a visualization of data the pipeline already produces.
- **Render:** a webview (mirror `src/visualizer.ts`) drawing the pipeline DAG (spec → model → contracts → map → IR → review → plan → tasks → implement → tests). Node states: `done` (solid), `missing` (outline), `blocked` (red), `stale` (amber glow), `frozen` (lock badge, from the Phase 1 `frozen` flag). Edges show the upstream→downstream dependency; a stale edge (upstream newer) is highlighted.
- **Per-node actions:** each node carries a **"Re-run this stage"** button bound to its producing slash command (the same mapping the tree's `runStage` uses), dispatched via `chatBridge`. A frozen node's button is disabled with a tooltip pointing at `/change` (consistent with the lifecycle guard). A "re-run from here" action dispatches `/run-pipeline --folder <folder>` resumed at that stage.
- **Entry point:** a `spec2integration.openStageGraph` command + a tree toolbar icon, alongside the existing "Open IR Visualizer".

### Files

| File | Change |
|---|---|
| `src/stageGraph.ts` | **New.** Webview host; reads `status.json`, builds nodes/edges from the encoded dependency map, posts re-run messages back to the extension. |
| `media/stage-graph/` | **New.** Webview HTML/CSS/JS (reuse the visualizer's bundling in `esbuild.js`). |
| `src/tree.ts`, `src/extension.ts`, `package.json` | Register `spec2integration.openStageGraph`; add the toolbar icon; route node "re-run" messages to the existing stage-dispatch path. |

### Testing

- Edit `spec.md` after the IR exists; open the panel; confirm the IR node (and downstream) glow amber and name `spec.md` as the trigger; click "re-run this stage" and confirm it dispatches `/architect`.
- Confirm a frozen integration shows lock badges and disabled re-run buttons that point at `/change`.
- Confirm the panel reflects a `status.json` refresh live (watch + repaint).

### Risks

- **Dependency-map duplication.** The map now lives in the `pipeline-status` skill (prose) and the PS1 hook (code); adding a TS copy is a third. Mitigation: encode it as a single exported TS constant and add a note in the skill that the three must stay in sync (or, stretch goal, generate the TS edge list from a shared JSON the hook also reads).
- Graph layout for large pipelines — use a simple layered layout; this is a DAG with ~15 nodes, not arbitrary.

---

## Item 10 — Diff-and-approve gate before live edits land

### Problem

On a deployed (frozen) integration, a `/change` run lets an Azure agent edit a live artifact. Today those edits land silently in the working tree; we want the user to **see a diff and approve** before trusting them. Because the extension cannot intercept the agent's writes (governing constraint), there are two complementary mechanisms, and the plan proposes both with the lighter one first.

### Design A — post-edit git diff surface in the extension (the "S" core)

- After a `/change` (or any dispatched command) touches a **frozen** folder, the extension detects the working-tree change (git status watch on the folder) and raises a **"Review changes to a live integration"** notification.
- A **diff-and-approve view** lists each changed artifact with its `git diff`; per-file actions **Approve (keep)** and **Discard (checkout)**. "Approve all" clears the review; "Discard" reverts that file.
- This reuses item 8's checkpoint plumbing (the checkpoint taken before dispatch is the diff base) and the `frozen`/`lifecycle` flags to decide *when* to force the review (only for post-implementation folders, so normal greenfield editing is not nagged).

### Design B — true pre-write gate via a `PreToolUse` hook (the "M" upgrade)

- Add a `PreToolUse` hook on `Write|Edit` (sibling to the existing `PostToolUse` `refresh-status.ps1` in `.claude/settings.json`). When the target path is inside a `lifecycle: post-implementation` folder, the hook returns a **block/ask decision** so Claude Code pauses for confirmation *before* the write lands — a real gate, at the layer that actually sees the write.
- This is the only mechanism that gates *before* the edit; the extension's Design A gates *after* (revertable). Ship A first (pure extension + git), add B if a hard pre-write stop is wanted.

### Files

| File | Change |
|---|---|
| `src/reviewGate.ts` | **New.** Working-tree-change watch for frozen folders; the diff-and-approve webview; per-file approve/discard via git. |
| `src/tree.ts`, `src/extension.ts`, `package.json` | Register `spec2integration.reviewChanges`; a "pending review" badge on folders with unapproved live edits; a `spec2integration.reviewGate` setting (`off` / `frozen-only` / `always`). |
| `scripts/pretooluse-guard.ps1` | **New (Design B).** The `PreToolUse` hook: read the target path, resolve the owning integration folder, check `status.json.lifecycle`; emit an ask/deny decision for frozen folders. |
| `.claude/settings.json` | **(Design B)** Add the `PreToolUse` `Write|Edit` hook entry. Document opt-out (remove the block), mirroring the PostToolUse note in CLAUDE.md. |

### Testing

- Design A: on a frozen folder, run `/change`; confirm the review notification appears, the diff view lists the edited artifact, and Approve/Discard behave (discard reverts via git).
- Design B: with the PreToolUse hook enabled, confirm an edit inside a frozen folder prompts before landing, and an edit in a `generate` folder does not.
- Confirm neither mechanism fires for normal greenfield (lifecycle `generate`) editing.

### Risks

- **Design B UX friction** — a pre-write prompt on every edit in a frozen folder can be noisy; scope it to frozen folders only and make it a setting. It also depends on the Claude Code `PreToolUse` hook decision contract — verify the installed version supports an ask/deny response before committing to B.
- **Diff noise** from formatter/line-ending changes — normalize with `git diff --ignore-cr-at-eol` and respect `.gitattributes`.

---

## Sequencing

1. **Item 9 (stage graph)** first — highest visible value, lowest risk, pure read-only visualization over data that already exists. It also establishes the TS encoding of the dependency map that items 8/10 reference.
2. **Item 8 (checkpoints)** next — introduces the git-snapshot plumbing that item 10's diff surface reuses.
3. **Item 10 Design A** (git diff surface) on top of item 8's checkpoints; **Design B** (PreToolUse hook) only if a hard pre-write stop is wanted.

## Out of scope

- Injecting into or awaiting a running Claude session — not achievable from a third-party extension (governing constraint). All completion detection is via `status.json` refresh.
- Re-running stages headlessly — the extension stays prompt-driven; it dispatches commands to chat, it does not execute them itself.
- Any change to the generative agents themselves — Phase 4 is UI + one hook, consuming the artifacts and `status.json` the pipeline already produces.

## Cross-phase note

Phase 4 is the UI realization of the Phase 1 lifecycle model: `frozen`/`lifecycle` drive the DAG lock badges (item 9), the review-gate trigger (item 10), and the "revert" safety net (item 8). Shipping Phase 1 first was deliberate — it gives Phase 4 the state it renders and gates on.
