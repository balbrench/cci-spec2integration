// Guided wizard — walks a command's ArgSpec[] with QuickPick / InputBox / open
// dialogs and assembles the final "/command args" string. Returns undefined if
// the user cancels (Escape) at any step.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { ArgSpec, CommandSpec } from './commandCatalog';

export interface ComposeContext {
  repoRoot: string;
  /** repo-relative folder to use for `folder` args, when known. */
  defaultFolder?: string | null;
}

/** Quote a value for a shell-ish slash-command argument if it contains spaces. */
function maybeQuote(value: string, force = false): string {
  if (!force && !/\s/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Make an absolute fsPath repo-relative with POSIX separators. */
function toRepoRel(repoRoot: string, fsPath: string): string {
  const rel = path.relative(repoRoot, fsPath);
  return rel.split(path.sep).join('/');
}

async function pickFolderArg(
  spec: Extract<ArgSpec, { kind: 'folder' }>,
  ctx: ComposeContext,
): Promise<string | null | undefined> {
  // A known default (selected/active integration) is used silently — that is the
  // whole point of pinning an active integration.
  if (ctx.defaultFolder) return ctx.defaultFolder;
  if (spec.optional) return null;
  // No default: let the user type or pick a specs/ folder path.
  const value = await vscode.window.showInputBox({
    title: 'Integration folder',
    prompt: 'Repo-relative folder under specs/ (e.g. specs/001-order-intake). Leave blank to omit.',
    placeHolder: 'specs/<domain>/NNN-slug',
  });
  if (value === undefined) return undefined; // cancelled
  return value.trim() || null;
}

async function pickChoice(spec: Extract<ArgSpec, { kind: 'choice' }>): Promise<string[] | undefined> {
  const items = spec.options.map((o) => ({ label: o.label, description: o.description, value: o.value }));
  const sel = await vscode.window.showQuickPick(items, { title: spec.title, placeHolder: spec.title });
  if (!sel) {
    return spec.optional ? [] : undefined;
  }
  return spec.flag ? [spec.flag, sel.value] : [sel.value];
}

async function pickFlags(spec: Extract<ArgSpec, { kind: 'flags' }>): Promise<string[] | undefined> {
  const items = spec.options.map((o) => ({ label: o.label, description: o.description, flag: o.flag }));
  const sel = await vscode.window.showQuickPick(items, {
    title: spec.title,
    placeHolder: spec.title,
    canPickMany: true,
  });
  if (sel === undefined) return undefined; // cancelled
  return sel.map((s) => s.flag);
}

async function pickText(spec: Extract<ArgSpec, { kind: 'text' }>): Promise<string[] | undefined> {
  const value = await vscode.window.showInputBox({
    title: spec.title,
    prompt: spec.title,
    placeHolder: spec.placeholder,
  });
  if (value === undefined) return undefined; // cancelled
  const trimmed = value.trim();
  if (!trimmed) return [];
  const token = maybeQuote(trimmed, spec.quote === true);
  return spec.flag ? [spec.flag, token] : [token];
}

async function pickPath(
  spec: Extract<ArgSpec, { kind: 'path' }>,
  ctx: ComposeContext,
): Promise<string[] | undefined> {
  const uris = await vscode.window.showOpenDialog({
    title: spec.title,
    canSelectFiles: spec.canPickFiles ?? true,
    canSelectFolders: spec.canPickFolders ?? false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(ctx.repoRoot),
    openLabel: 'Select',
  });
  if (!uris || uris.length === 0) {
    return spec.optional ? [] : undefined;
  }
  const fsPath = uris[0].fsPath;
  // Prefer a repo-relative path when the selection is inside the repo.
  const rel = toRepoRel(ctx.repoRoot, fsPath);
  const value = rel.startsWith('..') ? fsPath : rel;
  const token = maybeQuote(value);
  return spec.flag ? [spec.flag, token] : [token];
}

async function pickCount(spec: Extract<ArgSpec, { kind: 'count' }>): Promise<string[] | undefined> {
  const value = await vscode.window.showInputBox({
    title: spec.title,
    prompt: spec.title,
    placeHolder: spec.placeholder,
    validateInput: (v) => (!v.trim() || /^\d+$/.test(v.trim()) ? undefined : 'Enter a whole number'),
  });
  if (value === undefined) return undefined; // cancelled
  const trimmed = value.trim();
  if (!trimmed) return [];
  return [spec.flag, trimmed];
}

/**
 * Walk every ArgSpec for a command and return the fully assembled prompt string,
 * e.g. "/run-pipeline --mode greenfield --input \"...\" --unattended".
 * Returns undefined if the user cancels.
 */
export async function compose(cmd: CommandSpec, ctx: ComposeContext): Promise<string | undefined> {
  const tokens: string[] = [];
  for (const spec of cmd.args) {
    let produced: string[] | null | undefined;
    switch (spec.kind) {
      case 'folder': {
        const f = await pickFolderArg(spec, ctx);
        if (f === undefined) return undefined;
        produced = f ? [f] : [];
        break;
      }
      case 'choice':
        produced = await pickChoice(spec);
        break;
      case 'flags':
        produced = await pickFlags(spec);
        break;
      case 'text':
        produced = await pickText(spec);
        break;
      case 'path':
        produced = await pickPath(spec, ctx);
        break;
      case 'count':
        produced = await pickCount(spec);
        break;
    }
    if (produced === undefined) return undefined; // cancelled
    if (produced) tokens.push(...produced);
  }
  return [cmd.command, ...tokens].join(' ').trim();
}
