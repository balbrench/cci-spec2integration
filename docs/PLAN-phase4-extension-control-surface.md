# Plan: VS Code extension control surface

**Status:** Plan for review (not yet implemented)
**Date:** 2026-10-21. Revised 2026-11-11 after v1.1.0: hook-based integration with Claude Code, and the single-writer `status.json`.
**Audience:** Engineers working on `tools/vscode-extension` (TypeScript) and the pipeline hooks
**Builds on:**
- the lifecycle model merged in PR #16 (`lifecycle` / `frozen` in `status.json`, `/change`);
- the single-writer `status.json` and artifact gates merged in PR #17 (v1.1.0);
- [PLAN-phase3-roundtrip-and-spec-quality.md](PLAN-phase3-roundtrip-and-spec-quality.md), whose Change 0 fixes the extension's command catalog.

## Purpose

Most framework changes are markdown, agent, skill, or script work. **This plan is TypeScript engineering inside `tools/vscode-extension`**, plus one shared data file, one pipeline hook, and one small command flag. It turns the extension from a passive IR visualizer into a **control surface** for the pipeline:

- see which stages an edit made stale, as a graph, and re-run them;
- checkpoint a stage run and revert it with one click;
- review and approve edits to a deployed integration.

Together these reduce the risk of the regeneration failure mode that the lifecycle guard addresses from the command side. Claude Code's `http` hooks let the extension hear when a run finishes and decide on writes before they land, so these no longer depend on guessing from file changes.

| # | Change | Effort |
|---|---|---|
| 0 | **Prerequisite:** one shared stage-dependency map, plus a test harness for the extension | S |
| 0b | **Prerequisite:** a hook listener in the extension (run completion + pre-write decisions), and documented deep links in `chatBridge` | M |
| 1 | **Stale-stage graph panel with per-stage re-run** | M |
| 2 | **Per-stage checkpoint and one-click revert** | M |
| 3 | **Review gate for edits to a deployed integration** | S for the post-edit review, S on top of 0b for the pre-write gate |

**How this differs from Claude Code's own checkpoints.** Claude Code can already rewind file edits made inside a session (`/rewind`). This plan adds what that doesn't cover: revert points labelled by **pipeline stage**, kept **across sessions** on the stage row, scoped to one integration folder, and covering files written by any means, including shell commands.

## The governing constraint — the extension sends prompts, and Claude Code calls back through hooks

This shapes every change below. Per [`src/chatBridge.ts`](../tools/vscode-extension/src/chatBridge.ts), the extension **assembles a slash command and hands it to the live Claude Code chat**. It tries, in order:
1. Claude Code's internal open command;
2. the `vscode://anthropic.claude-code/open` deep link;
3. the clipboard.

**What Claude Code documents (checked 2026-11-11, code.claude.com/docs/en/):**

| Capability | Documented? | Mechanism | Source |
|---|---|---|---|
| Open the chat with a prompt | Yes, pre-filled but **not** auto-submitted | `vscode://anthropic.claude-code/open?prompt=<encoded>` | `vs-code.md` |
| Resume or focus a specific session | Yes | `vscode://anthropic.claude-code/open?session=<id>` | `vs-code.md` |
| Call Claude Code's internal open command | **No.** Not a public API; may break in any release | — | — |
| Tell an external process that Claude finished a response | Yes | `http` hook on `Stop` (receives `session_id`, `last_assistant_message`) and `SubagentStop` | `hooks.md` |
| Approve, deny or ask before a write | Yes | `http` (or `command`) hook on `PreToolUse` returning `hookSpecificOutput.permissionDecision`; `onFailure: "block"` makes it fail closed | `hooks.md` |
| Push a prompt into an open, running chat | **No** for a distributable extension. Channels can, but they are a research preview, need claude.ai/Console auth, and custom channels load only with a development flag | `channels-reference.md` |
| Run a session the extension owns and waits on | Yes | Agent SDK `query()`, or `claude -p --output-format stream-json` | `agent-sdk/overview.md`, `headless.md` |

**What this means for the plan:**
- **The chat panel stays the way stages run.** Users keep their own Claude Code login and can watch and steer the run. The extension still cannot submit the prompt for them or inject into a running chat.
- **Completion is reported, not guessed.** A `Stop` http hook posts to a listener inside the extension (Change 0b), which replaces inferring completion from `status.json` changing. The `status.json` watcher stays as the fallback when the extension isn't running or the hook isn't installed.
- **A pre-write gate is extension code after all.** A `PreToolUse` http hook asks the extension's listener, which can show its own diff and answer allow, deny or ask (Change 3). Writes made through shell commands carry no target path, so the filesystem diff review stays as the safety net.
- **Checkpoint and revert stay git- and filesystem-based** around a dispatched command (Change 2). The hooks make the "after" moment precise.
- **The bridge switches to the documented deep link first**, keeping the internal command only as a fallback. It already reuses one session per pipeline run through `?session=` (`src/session.ts`, which creates the session with a tool-free `claude -p` call).

**Running stages headlessly is deferred.** The Agent SDK or `claude -p` would let the extension run a stage, stream it in its own UI, and decide on writes in code. But the SDK docs require an API key or Bedrock / Vertex / Foundry credentials, and do not allow third parties to offer claude.ai subscription login without Anthropic's approval. Every user would need their own API key. Whether an extension invoking the user's own installed `claude -p` falls under the same rule is not documented; settle that before building it. If it goes ahead, it would be an opt-in "run in background" for stages that need no input (`/review`, `/test-mappings`, `/test-flows`, `/status`).

What the extension **can** do, then:
- read the workspace filesystem and `<folder>/status.json`;
- run `git` on the workspace;
- render webviews (like `src/visualizer.ts` and `src/progress.ts`);
- contribute tree views and commands (`src/tree.ts`);
- dispatch slash commands through `chatBridge`;
- receive hook events from Claude Code on a local listener and answer `PreToolUse` decisions (Change 0b).

## Existing building blocks (reuse, don't rebuild)

| Asset | File | Reused by |
|---|---|---|
| Pipeline tree with stage rows and the `runStage` / `runNext` commands | `src/tree.ts`, `src/extension.ts`, `package.json` | 1, 2 |
| Webview pattern: a pre-built HTML page in `media/visualizer/`, loaded with `asWebviewUri` | `src/visualizer.ts` | 1 |
| Progress cockpit webview and `status.json` reads | `src/progress.ts`, `src/discovery.ts` | 1, 2 |
| `status.json` file watcher | `src/extension.ts` | 1, 2, 3 |
| Command dispatch to chat | `src/chatBridge.ts` | 1, 2, 3 |
| `staleness[]`, `lifecycle`, and `frozen` fields | `pipeline-status` and `lifecycle-guard` skills; `scripts/refresh-status.ps1` (the only writer of `status.json` since v1.1.0) | 1, 3 |
| Stage verdicts from report files (`implement-gates.json`, `review-report.json`, test reports) | `scripts/refresh-status.ps1`; `scripts/check-azure-artifacts.ps1` | 1 (node states) |
| `PostToolUse` hook wiring | `.claude/settings.json` `hooks` block | 0b (adds `Stop` and `PreToolUse` http siblings) |

---

## Change 0 — Shared dependency map and test harness (prerequisite)

### Shared stage-dependency map

**Problem.** The stage dependency map (which artifact each stage produces, and which upstream files make it stale) is written out twice today:
- in prose in the `pipeline-status` skill;
- as the `$depMap` hash table inside `Get-Staleness` in [`scripts/refresh-status.ps1`](../scripts/refresh-status.ps1).

The graph panel would add a third copy in TypeScript. Three hand-maintained copies will drift apart.

**Gap to fix while moving it.** Stage 10's artifact in `$depMap` is only `app`. Since v1.1.0, stage 10 also counts Function Apps (`FunctionApps/`) and ADF pipelines (`adf/`), so an integration with no `app/` folder is never marked stale. List all three artifact roots in the JSON. This is a deliberate behaviour change, so the before/after comparison below must expect it.

**Change.** Put the map in one data file, `schemas/stage-dependencies.json`: each stage id with its producing slash command (`{platform}` for the pack-specific ones), its artifact path(s), its upstream path(s), and repo-relative upstreams (`specs/PRD.md`, greenfield only). Stage names stay in the `status.json` rows, which the graph reads.

**Implemented** (branch `phase4-extension-control-surface`): the JSON; `refresh-status.ps1` reading it for staleness and producer commands; `src/stageMap.ts` with `loadStageMap`, `producerCommand` and `stageEdges`; and the skill pointing at it. The extension's `STAGE_CMD` table in `src/commandCatalog.ts` is still a hand-kept copy, now guarded by a unit test that fails if it disagrees with the map; Change 1 replaces it with the map.

| File | Change |
|---|---|
| `schemas/stage-dependencies.json` | **New.** The single source of the map. `sync-assets.js` already copies `schemas/` into the extension bundle, and scaffolding copies it into new workspaces, so no packaging change is needed. |
| `scripts/refresh-status.ps1` | Read the map from the JSON (`ConvertFrom-Json`) instead of the inline hash table. Behaviour must stay identical. |
| `.claude/skills/pipeline-status/SKILL.md` | Point the **Staleness** section at the JSON as the source of truth. Keep a short human-readable summary. |
| `src/stageMap.ts` | **New.** Load and type the map: from the workspace's `schemas/` when present, otherwise from the bundled `assets/schemas/`. |

**Testing.** Run `refresh-status.ps1` on the same test folder before and after the change and confirm the resulting `status.json` is identical, ignoring `generatedAt` and the intended stage-10 change above.

### Test harness

The extension has no automated tests today: no `test` script and no test folder. Change 2's revert is destructive, so it needs real tests.

- Add a `test` script using Node's built-in runner (`node --test`), with no new dependencies.
- Keep the git and graph logic in modules that **don't import `vscode`** (`checkpointCore.ts`, `stageGraphModel.ts`) so they can be tested in plain Node. The `vscode`-facing code stays a thin layer over them.
- Tests create a temporary git repository, run checkpoint/revert against it, and assert on the resulting files.

**Implemented:** `npm test` runs `node --test "test/**/*.test.ts"` using Node's built-in TypeScript type stripping (Node 22.18+), so tested modules must use erasable syntax only (no enums, namespaces or parameter properties) and are imported with their `.ts` extension. The release workflow now uses Node 22 and runs the tests before packaging. `test/**` is excluded from the `.vsix`.

---

## Change 0b — Hook listener and documented deep links (prerequisite)

### Problem

The extension learns about runs only by watching `status.json`. That misses runs that don't edit an integration folder, can't say which run finished, and gives no way to decide on a write before it lands. Its first delivery method is also an undocumented internal command.

### Design

**Local listener.** On activation the extension starts an HTTP server bound to `127.0.0.1` on a random free port. It writes the port and a random token to its per-workspace storage, and to a gitignored local file the hooks read (for example `.claude/settings.local.json`, below). Every request must carry the token; anything else is rejected.

**Hooks.** Claude Code `http` hooks post event JSON to the listener:

| Event | Used for | Response |
|---|---|---|
| `Stop` | A response finished. The listener matches `session_id` to the stage the extension dispatched, records it, and tells Changes 1 and 2 the run is over. | Empty `2xx`. A blocking response would keep Claude working. |
| `SubagentStop` | Progress inside a stage (`agent_type`), shown on the stage row. | Empty `2xx` |
| `PreToolUse` on `Write|Edit|MultiEdit|NotebookEdit` | The pre-write gate (Change 3). | `permissionDecision` of `allow`, `deny` or `ask` |

Notes:
- `Stop` fires after **every** response, not once per slash command. A stage that asks the user a question produces several. Treat the latest `Stop` for a session as "idle", and confirm completion against the stage's report file or `status.json` row.
- Don't use `SessionEnd`: its default time budget (about 1.5 s) is too short for a reliable HTTP call.
- The hook URL must be allowed by `allowedHttpHookUrls` if an organisation sets it.
- `transcript_path` is in the payload, but the transcript format is internal. Don't parse it.

**Where the hooks are configured.** The listener's port changes on every activation, and shared `.claude/settings.json` is committed. So the extension writes its hook entries to `.claude/settings.local.json` (per-user, gitignored), with a command to install or remove them. The existing `PostToolUse` refresh hook stays in `.claude/settings.json`. Hook settings are read at session start, so the extension prompts the user to restart Claude Code after installing them.

**When the extension isn't running.** An `http` hook to a dead port fails. For `Stop` and `SubagentStop` that is harmless. For `PreToolUse` it matters: the gate is either skipped or, with `onFailure: "block"`, blocks every write. Change 3 handles this.

**Deep links in `chatBridge`.** [`src/session.ts`](../tools/vscode-extension/src/session.ts) already keeps a whole pipeline run in one chat: it creates a session with a tool-free `claude -p` call, stores its id, and `chatBridge` reopens it with `?session=<id>`. Build on that rather than replacing it:
- Make the documented `vscode://anthropic.claude-code/open?prompt=` link (with `session=` when one is stored) the first method. Keep the internal command as a fallback only, since it's undocumented.
- Match `Stop` events to dispatches by the stored `session_id`. If the user runs a stage in a different chat, the `Stop` carries another id; record it on the stage row so "Open this stage's session" reopens the right one.
- The prompt is pre-filled, not submitted, so the user presses Enter. Say so in the notification.

### Files

| File | Change |
|---|---|
| `src/hookServer.ts` | **New.** Localhost listener, token check, event routing. A small core with no `vscode` import, so it can be unit-tested. |
| `src/hookInstall.ts` | **New.** Install or remove the hook entries in `.claude/settings.local.json`, preserving any other keys there. |
| `src/chatBridge.ts` | Documented deep link first (it already supports `?session=` through `src/session.ts`). |
| `src/extension.ts`, `package.json` | Commands `spec2integration.installHooks` / `removeHooks`; setting `spec2integration.hooks.enabled`. |
| `CLAUDE.md` | Describe the optional extension hooks next to the existing hook description. |

### Testing

- Unit: the listener rejects requests without the token, and routes `Stop` to the right stage by `session_id`.
- Manual: install the hooks, restart, run `/status` from the tree. Confirm the extension marks the run finished without waiting for `status.json`, and that "Open this stage's session" reopens it.
- Close VS Code and confirm a Claude Code CLI session still works: `Stop` fails silently, and no write is blocked.

### Risks

- **Stale port.** If VS Code restarts without the hooks being reinstalled, they point at a dead port. Rewrite the port on every activation; the file write is cheap.
- **Settings file conflicts.** Users may already have a `settings.local.json`. Merge only the extension's own entries, tagged so they can be found and removed.

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

**Implemented** (branch `phase4-extension-control-surface`), except "Re-run from here", which waits for the `--from` flag:
- `src/stageGraphModel.ts` builds the graph. Columns use the longest dependency path, and rows are ordered by the average row of each stage's predecessors to cut edge crossings.
- Stages with no file dependency get ordering-only edges from a new `after` field in `schemas/stage-dependencies.json` (1a after 1, 8 after 7, 12 after 10 and 11), drawn dashed. `refresh-status.ps1` ignores `after`.
- An edge is highlighted when it leads into a stale stage and its path matches that stage's `stalerThan`.
- `src/stageGraph.ts` hosts `media/stage-graph/index.html`, which uses a nonce-based CSP and inserts model strings as text only. "Re-run" goes through the same path as the tree's `runStage`; frozen stages are refused there as well as disabled in the webview.
- The tree, the progress view and the graph now share one `findStageForCommand` and read stage commands from the map. The hand-kept `STAGE_CMD` table is gone.
- Stages 1 (`/specify`) and 7 (`/platform`) stay non-runnable from a row because their commands need arguments other than the folder, as before.
- Checked by rendering the webview in headless Edge from a real `status.json`, including a frozen stage. It has not yet been tried inside VS Code.

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

**Detect completion.** When the Change 0b listener receives the `Stop` event for the dispatched session, compute the files changed since the checkpoint and show "N files changed by this run" on the stage row. Without the hooks, fall back to `status.json` changing. Also offer a manual **"Compare with last checkpoint"** action for runs neither signal catches.

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

- **Completion signal.** With the Change 0b hooks, `Stop` reports each finished response, but a stage that pauses to ask the user produces several, so the count can be shown before the stage is really done. Recompute on every `Stop`. Without the hooks, completion is inferred from `status.json`, and a run that edits files without triggering a refresh leaves the count stale. The manual "Compare with last checkpoint" action covers both.
- **False staleness after revert.** Git does not preserve modification times, and the hook marks a stage stale when an upstream file is *newer* than its artifact. Files restored a few milliseconds apart could therefore produce spurious stale flags. Setting all restored files to one shared timestamp prevents this.
- **Snapshot size.** Git objects are cheap and deduplicated. Copies of ignored files are small, and build output is excluded.

---

## Change 3 — Review gate for edits to a deployed integration

### Problem

On a deployed (frozen) integration, `/change` lets an Azure agent edit a live artifact. Since v1.1.0, `/change` runs the artifact gates (`scripts/check-azure-artifacts.ps1 -Build -Test`) after the edit and stops if they fail, so a broken edit is already caught. What's still missing is the **human** check: those edits land in the working tree without the user seeing a diff and approving it. There are two complementary mechanisms. Ship the lighter one first.

### Design A — post-edit diff review in the extension (the core)

- When files change inside a folder whose `status.json` has `lifecycle: post-implementation`, the extension raises a **"Review changes to a live integration"** notification.
- A review view lists each changed artifact with its diff, using `git diff --ignore-cr-at-eol` to suppress line-ending noise. Each file has **Approve (keep)** and **Discard** (restore from the diff base). **Approve all** clears the review.
- The diff base is the Change 2 checkpoint taken before the dispatched command, or `HEAD` when no checkpoint exists.
- **Excluded from review:** files the pipeline itself rewrites on every edit or every `/change`: `status.json`, `decisions.md`, and the generated reports (`*-report.md`, `*-report.json`). Without this, every review would be cluttered with bookkeeping.
- Design A is the **safety net for every write path**. Because it diffs the filesystem, it also catches files an agent wrote through a shell command, which a tool-call hook can miss.

### Design B — pre-write gate via the extension's `PreToolUse` hook (optional upgrade)

- Uses the `PreToolUse` http hook from Change 0b, matcher `Write|Edit|MultiEdit|NotebookEdit`. The listener reads the target path from the event. When the path is inside a `lifecycle: post-implementation` folder and is not one of the excluded bookkeeping files, it shows the proposed edit (old and new content from the tool input) in a diff view and answers:
  - **Approve:** `allow`;
  - **Reject:** `deny`, with a reason Claude sees ("rejected by reviewer");
  - **no decision within a time limit:** `ask`, so Claude Code's own prompt takes over.
  
  Anything outside a frozen folder gets `allow` straight away.
- **This replaces the planned `scripts/pretooluse-guard.ps1`.** The decision is TypeScript in the extension, so it works the same on Windows, macOS and Linux, and no `pwsh` is needed.
- **When the extension isn't running.** Leave `onFailure` at its default, so a dead listener lets the write through, and Design A stays the safety net. Teams that want a hard stop can set `onFailure: "block"`, accepting that every write is then blocked whenever VS Code is closed. Document both.
- **Known gap: shell writes.** Writes made through `Bash` (several agents and `/change` have Bash) carry no structured target path, so the hook cannot reliably gate them. Design A catches those after the fact. State this gap in the docs rather than gating every Bash call.

### Files

| File | Change |
|---|---|
| `src/reviewGate.ts` | **New.** Watches frozen folders for changes; the review webview; per-file approve and discard. Reuses `checkpointCore` for the diff base and discard. |
| `src/tree.ts`, `src/extension.ts`, `package.json` | Register `spec2integration.reviewChanges`; a "pending review" badge on folders with unapproved live edits; a `spec2integration.reviewGate` setting (`off` / `frozen-only` / `always`, default `frozen-only`). |
| `src/preWriteGate.ts` | **New (Design B).** Handles `PreToolUse` events from the Change 0b listener: find the owning integration folder, check `status.json` `lifecycle`, skip the excluded files, show the diff, and return the decision. |
| `src/hookInstall.ts` | **(Design B)** Add the `PreToolUse` entry when `spec2integration.reviewGate` is not `off`. |
| `CLAUDE.md` | **(Design B)** Describe the pre-write gate, its `onFailure` choice and its shell-write gap next to the existing hook description. |

### Testing

- **Design A:** on a frozen folder, run `/change` and confirm the review lists the edited artifact but **not** `status.json` or `decisions.md`, and that Approve and Discard behave correctly. Make an edit through a shell command and confirm Design A still catches it.
- **Design B:** confirm that an edit inside a frozen folder shows the diff before landing, that Reject stops it, that an edit in a `generate` folder is not gated, and that `status.json` updates are not gated. Close VS Code and confirm writes go through with the default `onFailure`. Confirm on Windows, plus macOS or Linux if available.
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
2. **Change 0b:** the hook listener and deep-link changes. Changes 1 and 2 work without it, using the `status.json` fallback, so it can ship in parallel with Change 1.
3. **Change 1 (stage graph):** the highest visible value and lowest risk, because it is a read-only view.
4. **Change 2 (checkpoints):** introduces the snapshot and revert code that Change 3 reuses.
5. **Change 3 Design A** on top of Change 2; **Design B** on top of Change 0b, if a pre-write stop is wanted.

## Out of scope

- Injecting a prompt into, or auto-submitting in, an open Claude Code chat. Not documented for third-party extensions; the deep link only pre-fills (see the governing constraint).
- Running stages headlessly through the Agent SDK or `claude -p`. Deferred until the login question in the governing constraint is settled.
- Parsing Claude Code transcripts (`transcript_path`); the format is internal.
- Changes to the generative agents. The only pipeline-side changes are the shared map and the optional `--from` flag.
- Making the existing Windows-only `PostToolUse` hook cross-platform (a separate change).

## Relationship to the lifecycle model

The `lifecycle` and `frozen` fields from PR #16 drive all three changes:
- the lock badges and disabled re-run buttons in the graph (Change 1);
- the safety net behind revert (Change 2);
- when the review gate fires (Change 3).
