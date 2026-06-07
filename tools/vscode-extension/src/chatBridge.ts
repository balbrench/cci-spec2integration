// Chat bridge — hand an assembled slash command to the live Claude Code chat.
//
// The project is intentionally prompt-driven (see README "Pipeline Runner UI"):
// the tool assembles the command, the human runs it in chat. We do NOT spawn a
// headless `claude -p` session here.
//
// There are three delivery strategies, tried most-direct first:
//
//   'command'   — call the Claude Code extension's open command in-process:
//                   claude-vscode.primaryEditor.open(undefined, prompt)
//                 This is exactly what the documented deep link routes to
//                 internally (its /open?prompt= handler calls the same command),
//                 minus the OS URI round-trip — so it's awaitable and can't
//                 silently no-op. The command id is internal to Claude Code, so a
//                 rejection (extension not installed / id renamed) falls through
//                 to the deep link, then the clipboard.
//   'deeplink'  — the documented, stable scheme
//                   vscode://anthropic.claude-code/open?prompt=<encoded>
//                 (tools/pipeline-runner/README.md). Configurable; clipboard is
//                 the guaranteed-working fallback.
//   'clipboard' — copy + notify; always works.
//
// All three open a NEW Claude Code conversation seeded with the prompt. Claude
// Code intentionally does NOT expose a way to inject into an already-open
// session (createPanel reveals an open session but discards the prompt), so
// "send to the current chat" is not achievable from a third-party extension.

import * as vscode from 'vscode';
import { getSessionId, setSessionId, captureSession } from './session';

export type Delivery = 'command' | 'deeplink' | 'clipboard';

/** Claude Code's internal open command — same target its /open deep link uses.
 *  Signature: (sessionId | undefined, prompt | undefined). Undefined session
 *  opens a new conversation pre-filled with the prompt. */
const OPEN_COMMAND = 'claude-vscode.primaryEditor.open';

function config() {
  const c = vscode.workspace.getConfiguration('spec2integration');
  return {
    delivery: c.get<Delivery>('chatDelivery', 'command'),
    scheme: c.get<string>('deepLinkScheme', 'vscode://anthropic.claude-code/open'),
    preview: c.get<boolean>('previewBeforeSend', true),
    continueSession: c.get<boolean>('continueSession', false),
  };
}

/** Optionally show the assembled command for review/edit before it is delivered. */
async function maybePreview(prompt: string): Promise<string | undefined> {
  if (!config().preview) return prompt;
  const edited = await vscode.window.showInputBox({
    title: 'Send to Claude Code chat',
    value: prompt,
    prompt: 'Review or edit the command, then press Enter to send (Esc to cancel).',
    valueSelection: [prompt.length, prompt.length],
  });
  if (edited === undefined) return undefined; // cancelled
  const trimmed = edited.trim();
  return trimmed || undefined;
}

async function copyToClipboard(prompt: string): Promise<void> {
  await vscode.env.clipboard.writeText(prompt);
  const choice = await vscode.window.showInformationMessage(
    `Command copied to clipboard — paste it into your Claude Code chat:  ${prompt}`,
    'Open Chat',
  );
  if (choice === 'Open Chat') {
    // Best-effort: focus the Claude Code chat view if the command exists.
    await tryFocusChat();
  }
}

async function tryFocusChat(): Promise<void> {
  const candidates = ['claude-code.focus', 'workbench.action.chat.open', 'claude.focus'];
  for (const id of candidates) {
    try {
      await vscode.commands.executeCommand(id);
      return;
    } catch {
      /* try next */
    }
  }
}

/** Open a new Claude Code conversation directly via its in-process command.
 *  Returns false if the command isn't registered (extension absent / renamed). */
async function tryCommand(prompt: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(OPEN_COMMAND, undefined, prompt);
    return true;
  } catch {
    return false; // command not found — caller falls back
  }
}

/** Fire the documented deep link. When `session` is given, the prompt resumes
 *  that conversation (and focuses its tab) instead of opening a new one — see
 *  code.claude.com/docs/en/vs-code. Returns false if the URI is rejected. */
async function tryDeepLink(prompt: string, scheme: string, session?: string): Promise<boolean> {
  const sessionPart = session ? `session=${encodeURIComponent(session)}&` : '';
  const uri = vscode.Uri.parse(`${scheme}?${sessionPart}prompt=${encodeURIComponent(prompt)}`);
  try {
    return await vscode.env.openExternal(uri);
  } catch {
    return false;
  }
}

/** Deliver into a single, reused pipeline session: ensure a captured session id
 *  (minting one on first use), then resume it via the deep link. Returns false
 *  if no session could be established, so the caller falls back to normal
 *  (new-conversation) delivery. */
async function trySessionDelivery(prompt: string, scheme: string): Promise<boolean> {
  let id = getSessionId();
  if (!id) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return false;
    id = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting a Claude Code session for this pipeline…' },
      () => captureSession(cwd),
    );
    if (!id) {
      void vscode.window.showWarningMessage(
        'Could not start a reusable Claude Code session (is the `claude` CLI on PATH and signed in?). ' +
          'Falling back to a new conversation — disable `spec2integration.continueSession` to silence this.',
      );
      return false;
    }
    await setSessionId(id);
  }
  return tryDeepLink(prompt, scheme, id);
}

/** Deliver the assembled command per the user's configured strategy, degrading
 *  gracefully: command → deep link → clipboard. */
export async function sendToChat(rawPrompt: string): Promise<void> {
  const prompt = await maybePreview(rawPrompt);
  if (prompt === undefined) return; // cancelled at preview
  const { delivery, scheme, continueSession } = config();

  // Keep the whole pipeline in one tab: resume a reused session via the deep link.
  // Falls through to normal delivery if a session can't be established.
  if (continueSession && (await trySessionDelivery(prompt, scheme))) return;

  if (delivery === 'clipboard') {
    await copyToClipboard(prompt);
    return;
  }

  // 'command' tries the in-process call first; 'deeplink' skips straight to the link.
  if (delivery === 'command' && (await tryCommand(prompt))) return;

  if (await tryDeepLink(prompt, scheme)) return;

  // Nothing worked (or was rejected) — guaranteed fallback.
  await copyToClipboard(prompt);
}
