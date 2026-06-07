# Pipeline Runner

A standalone, zero-dependency localhost tool that **actually runs** the Spec2Integration
slash commands (instead of copy-pasting them into chat). It is a sibling of
[`tools/vscode-extension/`](../vscode-extension/) (which hosts the IR visualizer) and
does **not** modify it.

```
node tools/pipeline-runner/server.mjs            # http://127.0.0.1:8099/
node tools/pipeline-runner/server.mjs --port 9000 --open
```

Then pick an integration and click a command. Output streams into the log pane.

## How it works

- Each button POSTs to the local server, which shells out to:
  ```
  claude -p "<command> <folder>" --output-format stream-json --verbose --permission-mode <mode>
  ```
  with `cwd` = repo root, so the headless session loads `CLAUDE.md`, `.claude/commands/*`,
  skills, and `settings.json` exactly like your interactive session.
- The `stream-json` events are streamed back to the browser over SSE and pretty-printed
  (assistant text, tool calls, final result + duration/cost).
- After a real run finishes, the status table re-reads `status.json` automatically.

## Important: this is a SEPARATE session, not your VS Code chat

Claude Code exposes **no** supported way to inject-and-submit a command into the running
interactive chat. So this runner spawns an **independent headless session**. Consequences:

- Results appear **here**, in the log pane — not in your VS Code Claude chat.
- File edits the command makes happen on disk (and the visualizer/status will reflect them),
  but they won't stream into the VS Code editor UI the way an interactive edit does.
- If you want the command in your live chat instead, use the `vscode://anthropic.claude-code/open?prompt=…`
  deep link (pre-fills the chat box, you press Enter) — that's a different, manual flow.

## Permission mode

Headless runs can't pause for interactive approval. Pick the mode in the toolbar:

| Mode | Use for |
|---|---|
| `acceptEdits` (default) | Read/plan-ish commands (`/status`, `/review`, `/plan`, `/tasks`). File edits auto-approved; **other tools (Bash) still prompt → may stall.** |
| `bypassPermissions` | `/implement-azure`, `/test-azure` and anything that runs Bash (ajv, `az bicep build`, `dotnet`). Skips all permission checks — only use on a workspace you trust. |
| `default` / `auto` | Standard gating; will stall on the first prompt in headless mode for write/Bash-heavy commands. |

Tick **dry-run** to see the exact `claude` invocation without executing it.

## Security

- Binds to `127.0.0.1` only.
- Commands are restricted to a fixed allow-list (the pipeline slash commands).
- The folder argument must match `specs/.../NNN-slug`, resolve under `specs/`, and exist —
  no path traversal, no arbitrary shell input.
- `bypassPermissions` lets the spawned agent run anything the pipeline commands run; treat the
  port as a local-trust boundary and don't expose it.

## Requirements

- `claude` CLI on PATH (`claude --version`), authenticated.
- Node 18+ (uses built-in `http`, `child_process`, `fs/promises` — no `npm install`).
