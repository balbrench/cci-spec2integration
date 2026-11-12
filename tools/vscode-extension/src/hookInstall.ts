// Hook installer — adds or removes the extension's Claude Code `http` hooks in
// the workspace's .claude/settings.local.json (Phase 4, Change 0b).
//
// settings.local.json is per-user and gitignored, which suits entries that
// carry this machine's port and token. Claude Code merges hooks across
// settings files, so the shared PostToolUse refresh hook in .claude/settings.json
// keeps running alongside these.
//
// The extension's entries are recognised by their URL path
// (/spec2integration/hook/), so no marker key is added to the settings schema.
// Everything else in the file is preserved. An unparseable file is never
// overwritten.
//
// No `vscode` import: unit-tested in plain Node.

import { HOOK_PATH_PREFIX, TOKEN_HEADER } from './hookServerCore.ts';

/** Events the extension listens to. PreToolUse is added by the review gate (Change 3). */
export const DEFAULT_EVENTS: readonly string[] = ['Stop', 'SubagentStop'];

/** Seconds Claude Code waits for the listener. The default is 600; a local call needs far less. */
export const HOOK_TIMEOUT_SECONDS = 5;

type HookHandler = { type?: string; url?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookHandler[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

const isOurs = (h: HookHandler) => h.type === 'http' && typeof h.url === 'string' && h.url.includes(HOOK_PATH_PREFIX);

function parse(text: string | undefined): Settings {
  if (text === undefined || text.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new Error(`settings.local.json is not valid JSON, so it was left unchanged (${(err as Error).message})`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('settings.local.json is not a JSON object, so it was left unchanged');
  }
  return v as Settings;
}

/** Drop the extension's handlers, then any groups and events left empty. */
function strip(settings: Settings): void {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return;
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
}

export function hookUrl(port: number, event: string): string {
  return `http://127.0.0.1:${port}${HOOK_PATH_PREFIX}${event}`;
}

/** The settings text with the extension's hooks for `events` (re)written for this port and token. */
export function applyHooks(text: string | undefined, port: number, token: string, events: readonly string[] = DEFAULT_EVENTS): string {
  const settings = parse(text);
  strip(settings);
  const hooks = (settings.hooks ??= {});
  for (const event of events) {
    (hooks[event] ??= []).push({
      hooks: [
        {
          type: 'http',
          url: hookUrl(port, event),
          timeout: HOOK_TIMEOUT_SECONDS,
          headers: { [TOKEN_HEADER]: token },
        },
      ],
    });
  }
  return JSON.stringify(settings, null, 2) + '\n';
}

/** The settings text without the extension's hooks. */
export function removeHooks(text: string | undefined): string {
  const settings = parse(text);
  strip(settings);
  return JSON.stringify(settings, null, 2) + '\n';
}

/** The port and token the extension's hooks currently point at, if installed. */
export function installedHook(text: string | undefined): { port: number; token: string; events: string[] } | undefined {
  let settings: Settings;
  try {
    settings = parse(text);
  } catch {
    return undefined;
  }
  let found: { port: number; token: string; events: string[] } | undefined;
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g.hooks ?? []) {
        if (!isOurs(h)) continue;
        const port = Number(new URL(h.url as string).port);
        const token = String((h.headers as Record<string, unknown> | undefined)?.[TOKEN_HEADER] ?? '');
        found ??= { port, token, events: [] };
        found.events.push(event);
      }
    }
  }
  return found;
}
