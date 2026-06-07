// Stage -> artifact / report resolution and open helpers.
//
// Lets the tree turn a stage row into navigation: open the artifact the stage
// produces, or jump to the report that explains a blocked / findings state.
// Paths are folder-relative; the first candidate that exists on disk wins.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

/** Stage id -> candidate primary artifact paths (folder-relative). First existing wins. */
const STAGE_ARTIFACTS: Record<string, string[]> = {
  // Inventory & catalogue live one level up, beside the domain folder (BizTalk path).
  '0a': ['../biztalk-inventory.md'],
  '0b': ['../integration-catalogue.md'],
  '1': ['spec.md'],
  '1a': ['clarifications.md'],
  '2': ['data-model.md'],
  '3': ['contracts/openapi.yaml', 'contracts'],
  '3a': ['contracts/openapi.yaml', 'contracts'],
  '4': ['mappings'],
  '5': ['integration-ir.yaml'],
  '8': ['plan.md', 'plan-blocked.md'],
  '9': ['tasks.md'],
  '10': ['app', 'FunctionApps', 'Functions'],
  '11': ['tests-mstest'],
  '12': ['azure.yaml'],
};

/** Stage id -> candidate report files (folder-relative), preferring human-readable .md. */
const STAGE_REPORTS: Record<string, string[]> = {
  '3a': ['contract-lint-report.md', 'contract-lint-report.json'],
  '5a': ['ir-validation-report.md', 'ir-validation-report.json'],
  '5b': ['stm-drift-report.md', 'stm-drift-report.json'],
  '5c': ['secret-scan-report.md', 'secret-scan-report.json'],
  '5d': ['pii-flow-report.md', 'pii-flow-report.json'],
  '5e': ['review-report.md', 'review-report.json'],
  '6': ['mapping-test-report.md', 'mapping-test-report.json'],
  '6a': ['flow-test-report.md', 'flow-test-report.json'],
  '8': ['plan-blocked.md'],
  '11': ['TEST-REPORT.md'],
};

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(
  repoRoot: string,
  folder: string,
  candidates: string[] | undefined,
): Promise<string | undefined> {
  for (const rel of candidates ?? []) {
    if (await exists(path.resolve(repoRoot, folder, rel))) return rel;
  }
  return undefined;
}

/** Folder-relative path of the stage's primary artifact, if one exists on disk. */
export function resolveArtifact(repoRoot: string, folder: string, stageId: string): Promise<string | undefined> {
  return firstExisting(repoRoot, folder, STAGE_ARTIFACTS[stageId]);
}

/** Folder-relative path of the stage's report, if one exists on disk. */
export function resolveReport(repoRoot: string, folder: string, stageId: string): Promise<string | undefined> {
  return firstExisting(repoRoot, folder, STAGE_REPORTS[stageId]);
}

/** Open a folder-relative path in a rendered preview when it makes sense:
 *  Markdown → the built-in Markdown preview; anything else → an editor tab. */
export async function openPreview(repoRoot: string, folder: string, rel: string): Promise<void> {
  const abs = path.resolve(repoRoot, folder, rel);
  if (!(await exists(abs))) {
    vscode.window.showWarningMessage(`Not found: ${path.relative(repoRoot, abs)}`);
    return;
  }
  const uri = vscode.Uri.file(abs);
  if (rel.toLowerCase().endsWith('.md')) {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } else {
    await vscode.window.showTextDocument(uri, { preview: true });
  }
}

/** Open a folder-relative path: text documents in an editor, directories in the explorer. */
export async function openPath(repoRoot: string, folder: string, rel: string): Promise<void> {
  const abs = path.resolve(repoRoot, folder, rel);
  let isDir = false;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    vscode.window.showWarningMessage(`Not found: ${path.relative(repoRoot, abs)}`);
    return;
  }
  const uri = vscode.Uri.file(abs);
  if (isDir) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
  } else {
    await vscode.window.showTextDocument(uri, { preview: true });
  }
}
