// Claude Code session capture & store.
//
// To keep an entire pipeline run in a single Claude Code conversation tab we use
// the documented `session=` parameter of the `vscode://anthropic.claude-code/open`
// deep link (see code.claude.com/docs/en/vs-code) — it resumes a session and
// focuses its tab instead of spawning a new conversation. The one thing the
// extension can't read is the active GUI session's id, so we *mint* a reusable
// session once via a tool-free headless `claude -p` bootstrap and capture its id.
// The bootstrap does no tool use, so it never hits a permission prompt; every
// real pipeline command still goes through the GUI for human review.

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';

const KEY = 'spec2integration.claudeSessionId';

let memento: vscode.Memento | undefined;

export function initSessionStore(context: vscode.ExtensionContext): void {
  memento = context.workspaceState;
}

export function getSessionId(): string | undefined {
  return memento?.get<string>(KEY);
}

export async function setSessionId(id: string | undefined): Promise<void> {
  await memento?.update(KEY, id);
}

function cliPath(): string {
  return vscode.workspace.getConfiguration('spec2integration').get<string>('claudeCliPath', 'claude');
}

/**
 * Mint a Claude Code session in `cwd` via a tool-free headless bootstrap and
 * return its session id, or undefined if the CLI is unavailable / errors / times
 * out. The caller falls back to normal (new-conversation) delivery on undefined.
 */
export function captureSession(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v?: string) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    let child;
    try {
      child = spawn(
        cliPath(),
        ['-p', 'Spec2Integration is initializing a pipeline session. Reply with just: ready', '--output-format', 'json'],
        { cwd },
      );
    } catch {
      return finish(undefined);
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(undefined);
    }, 60_000);

    let out = '';
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(out);
        const id = json.session_id ?? json.sessionId;
        finish(typeof id === 'string' && id ? id : undefined);
      } catch {
        finish(undefined);
      }
    });
  });
}
