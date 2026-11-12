// Claude Code hook integration — the VS Code side of Phase 4, Change 0b.
//
// When `spec2integration.hooks.enabled` is on, the extension runs a localhost
// listener (hookServerCore.ts) and points Stop / SubagentStop `http` hooks in
// .claude/settings.local.json at it (hookInstall.ts). Each command sent to the
// chat is recorded (dispatchTracker.ts), so a Stop event can say which command
// just finished: the status bar shows it running and then finished, and the
// extension repaints without waiting for status.json to change.
//
// Off by default: it writes to the user's local Claude Code settings.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { startHookServer, HookServer } from './hookServerCore';
import { applyHooks, removeHooks, installedHook } from './hookInstall';
import { DispatchTracker, Dispatch } from './dispatchTracker';

const PORT_KEY = 'spec2integration.hookPort';
const TOKEN_KEY = 'spec2integration.hookToken';
const SETTINGS_REL = path.join('.claude', 'settings.local.json');

export const tracker = new DispatchTracker();

let server: HookServer | undefined;
let item: vscode.StatusBarItem | undefined;
let hideTimer: NodeJS.Timeout | undefined;
let finishedCallback: ((d: Dispatch) => void) | undefined;

export function hooksEnabled(): boolean {
  return vscode.workspace.getConfiguration('spec2integration').get<boolean>('hooks.enabled', false);
}

export function hooksRunning(): boolean {
  return server !== undefined;
}

function statusItem(): vscode.StatusBarItem {
  if (!item) {
    item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    item.name = 'Spec2Integration: Claude Code run';
  }
  return item;
}

function show(d: Dispatch): void {
  const it = statusItem();
  if (hideTimer) clearTimeout(hideTimer);
  if (d.state === 'running') {
    it.text = `$(sync~spin) ${d.command}${d.lastAgent ? ' · ' + d.lastAgent : ''}`;
    it.tooltip = `Sent to Claude Code${d.folder ? ' for ' + d.folder : ''}. Waiting for it to finish.`;
  } else {
    it.text = `$(check) ${d.command} finished`;
    const msg = d.lastMessage ? `\n\n${d.lastMessage.slice(0, 400)}${d.lastMessage.length > 400 ? '…' : ''}` : '';
    it.tooltip = new vscode.MarkdownString(`Claude Code finished responding to \`${d.command}\`.${msg}`);
    hideTimer = setTimeout(() => it.hide(), 30_000);
  }
  it.show();
}

/** Record a command the chat bridge just delivered. No-op unless the listener runs. */
export function recordDispatch(prompt: string, sessionId?: string): void {
  if (!server) return;
  const tokens = prompt.trim().split(/\s+/);
  const folder = tokens.find((t) => /^specs\/.+\/\d{3}-/.test(t) || /^specs\/\d{3}-/.test(t));
  show(tracker.record({ command: tokens[0] ?? prompt, folder, sessionId }));
}

/** Every event the listener has accepted, matched or not (for the connection test). */
let eventsReceived = 0;

function onEvent(event: Record<string, unknown>): undefined {
  eventsReceived++;
  const r = tracker.handle(event);
  if (r) {
    show(r.dispatch);
    if (r.finished) finishedCallback?.(r.dispatch);
  }
  return undefined; // Stop / SubagentStop: no decision
}

async function readText(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch {
    return undefined;
  }
}

/** 0: ignored, 1: tracked-able (not ignored), other: not a git repo / no git. */
function gitCheckIgnore(repoRoot: string, rel: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', rel], { cwd: repoRoot }, (err) => {
      if (!err) return resolve(0);
      const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve(typeof code === 'number' ? code : 128);
    });
  });
}

/** Make sure the token never gets committed: offer to gitignore settings.local.json. */
async function ensureIgnored(repoRoot: string): Promise<void> {
  const rel = SETTINGS_REL.split(path.sep).join('/');
  if ((await gitCheckIgnore(repoRoot, rel)) !== 1) return;
  const add = 'Add to .gitignore';
  const pick = await vscode.window.showWarningMessage(
    `${rel} is not gitignored. It will hold this machine's hook port and token, so it should not be committed.`,
    add,
    'Leave it',
  );
  if (pick !== add) return;
  const gi = path.join(repoRoot, '.gitignore');
  const current = (await readText(gi)) ?? '';
  await fs.writeFile(gi, current + (current === '' || current.endsWith('\n') ? '' : '\n') + rel + '\n', 'utf-8');
}

/**
 * Start the listener and make settings.local.json point at it. Reuses the
 * workspace's previous port when it is free, so sessions that already loaded
 * the hooks keep reaching the extension.
 */
export async function startHooks(
  context: vscode.ExtensionContext,
  repoRoot: string,
  onFinished: (d: Dispatch) => void,
): Promise<void> {
  finishedCallback = onFinished;
  let token = context.workspaceState.get<string>(TOKEN_KEY);
  if (!token) {
    token = randomBytes(24).toString('hex');
    await context.workspaceState.update(TOKEN_KEY, token);
  }
  if (!server) {
    server = await startHookServer({ token, port: context.workspaceState.get<number>(PORT_KEY), onEvent });
    await context.workspaceState.update(PORT_KEY, server.port);
  }

  const file = path.join(repoRoot, SETTINGS_REL);
  const text = await readText(file);
  const now = installedHook(text);
  if (now && now.port === server.port && now.token === token) return; // already current
  await ensureIgnored(repoRoot);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, applyHooks(text, server.port, token), 'utf-8');
  } catch (err) {
    vscode.window.showErrorMessage(`Spec2Integration: could not install Claude Code hooks: ${(err as Error).message}`);
    return;
  }
  const test = 'Test now';
  const pick = await vscode.window.showInformationMessage(
    `Claude Code hooks ${now ? 'updated' : 'added'} in ${SETTINGS_REL} (Stop, SubagentStop → 127.0.0.1:${server.port}). ` +
      'Claude Code normally picks up settings changes by itself; if a session already open does not report back, start a new one.',
    test,
  );
  if (pick === test) await testHooks(repoRoot);
}

function runClaude(cwd: string): Promise<number> {
  const cli = vscode.workspace.getConfiguration('spec2integration').get<string>('claudeCliPath', 'claude');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cli, ['-p', 'Spec2Integration is testing its hook connection. Reply with just: ready', '--output-format', 'json'], {
        cwd,
        shell: process.platform === 'win32', // resolve claude.cmd on Windows
        stdio: 'ignore',
      });
    } catch {
      return resolve(-1);
    }
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/**
 * Check that Claude Code actually delivers the hooks: run one tiny headless
 * prompt in the workspace (which loads its .claude/settings.local.json) and
 * see whether a Stop event reaches the listener.
 */
export async function testHooks(repoRoot: string): Promise<void> {
  if (!server) {
    vscode.window.showWarningMessage('Connect the Claude Code hooks first ("Spec2Integration: Connect Claude Code Hooks").');
    return;
  }
  const before = eventsReceived;
  const code = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Testing the Claude Code hook connection (one short claude -p prompt)…' },
    () => runClaude(repoRoot),
  );
  await new Promise((r) => setTimeout(r, 1500)); // let a late POST land
  if (code !== 0) {
    vscode.window.showErrorMessage(
      `The test prompt did not run (exit ${code}). Check that the claude CLI is on PATH and signed in, or set spec2integration.claudeCliPath.`,
    );
  } else if (eventsReceived > before) {
    vscode.window.showInformationMessage('Claude Code hooks are working: the extension received the Stop event.');
  } else {
    vscode.window.showWarningMessage(
      'Claude Code ran but sent no hook event, so run completion will be inferred from status.json instead. ' +
        'A common cause is an organisation policy that allows only managed hooks (allowManagedHooksOnly), which drops ' +
        'user and project hooks, including this repo\'s status-refresh hook. Ask whoever manages your Claude Code policy, ' +
        'or check `claude --debug` output for "allowManagedHooksOnly".',
    );
  }
}

export async function stopHooks(): Promise<void> {
  const s = server;
  server = undefined;
  item?.hide();
  if (s) await s.close();
}

/** Stop the listener and remove the extension's entries from settings.local.json. */
export async function uninstallHooks(repoRoot: string): Promise<void> {
  await stopHooks();
  const file = path.join(repoRoot, SETTINGS_REL);
  const text = await readText(file);
  if (!installedHook(text)) return;
  try {
    await fs.writeFile(file, removeHooks(text), 'utf-8');
    vscode.window.showInformationMessage(`Removed the Spec2Integration hooks from ${SETTINGS_REL}.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Spec2Integration: could not remove the hooks: ${(err as Error).message}`);
  }
}
