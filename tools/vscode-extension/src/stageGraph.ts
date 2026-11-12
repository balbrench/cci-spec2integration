// Stage graph webview host — the stale-stage graph panel (Phase 4, Change 1).
//
// Loads media/stage-graph/index.html, builds the model from <folder>/status.json
// and the shared stage map (src/stageGraphModel.ts), and posts it in. It repaints
// when status.json changes (refreshStageGraph, called from the watcher in
// extension.ts). "Re-run" requests go back to the extension's normal stage
// dispatch; frozen stages are refused here as well as in the webview.

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readStatus } from './discovery';
import { buildStageGraph } from './stageGraphModel';
import type { StageMap } from './stageMap';
import { stageCommand } from './commandCatalog';
import { openPath, resolveArtifact, resolveReport } from './artifacts';

export interface StageGraphDeps {
  /** The loaded stage map, or undefined when none could be read. */
  getMap(): StageMap | undefined;
  /** Send a stage's command for `folder` to Claude Code (the tree's runStage path). */
  runStage(folder: string, stageId: string): Promise<void>;
}

let panel: vscode.WebviewPanel | undefined;
let currentFolder: string | null = null;
let ctx: { repoRoot: string; deps: StageGraphDeps } | undefined;

function buildHtml(raw: string, webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const csp =
    `default-src 'none'; img-src ${webview.cspSource} data:; ` +
    `script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `font-src ${webview.cspSource}; connect-src 'none';`;
  return raw
    .replace(/<head>/i, `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace(/<script>/g, `<script nonce="${nonce}">`);
}

async function postModel(): Promise<void> {
  if (!panel || !ctx) return;
  if (!currentFolder) {
    await panel.webview.postMessage({ type: 'model', model: null, error: 'No integration selected and no active integration set.' });
    return;
  }
  const map = ctx.deps.getMap();
  if (!map) {
    await panel.webview.postMessage({
      type: 'model',
      model: null,
      error: 'Cannot read schemas/stage-dependencies.json from the workspace or the extension bundle.',
    });
    return;
  }
  const status = await readStatus(ctx.repoRoot, currentFolder);
  if (!status) {
    await panel.webview.postMessage({ type: 'model', model: null, error: `No status.json in ${currentFolder} yet.` });
    return;
  }
  const model = buildStageGraph(currentFolder, status, map, stageCommand);
  await panel.webview.postMessage({ type: 'model', model });
}

async function onMessage(msg: { type?: string; stageId?: string }): Promise<void> {
  if (!ctx || !currentFolder) return;
  const folder = currentFolder;
  switch (msg.type) {
    case 'ready':
      await postModel();
      return;
    case 'runNext':
      await vscode.commands.executeCommand('spec2integration.runNext', { folder });
      return;
    case 'run': {
      if (!msg.stageId) return;
      // Re-read: the panel's copy may be older than status.json.
      const status = await readStatus(ctx.repoRoot, folder);
      const stage = status?.stages?.find((s) => s.id === msg.stageId);
      if (stage?.frozen) {
        vscode.window.showInformationMessage(
          `Stage ${stage.id} ${stage.name} is frozen. Use /change for a targeted edit to the deployed artifacts.`,
        );
        return;
      }
      await ctx.deps.runStage(folder, msg.stageId);
      return;
    }
    case 'openReport': {
      if (!msg.stageId) return;
      const rel =
        (await resolveArtifact(ctx.repoRoot, folder, msg.stageId)) ??
        (await resolveReport(ctx.repoRoot, folder, msg.stageId));
      if (!rel) {
        vscode.window.showInformationMessage(`Stage ${msg.stageId} has no artifact or report on disk yet.`);
        return;
      }
      await openPath(ctx.repoRoot, folder, rel);
      return;
    }
  }
}

export async function openStageGraph(
  context: vscode.ExtensionContext,
  repoRoot: string,
  folder: string | null,
  deps: StageGraphDeps,
): Promise<void> {
  ctx = { repoRoot, deps };
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'stage-graph');
  let raw: string;
  try {
    raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaRoot, 'index.html'))).toString('utf-8');
  } catch {
    vscode.window.showErrorMessage('Bundled stage graph asset is missing (media/stage-graph/index.html).');
    return;
  }

  currentFolder = folder;
  if (!panel) {
    panel = vscode.window.createWebviewPanel('spec2integration.stageGraph', 'Stage Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    panel.onDidDispose(() => {
      panel = undefined;
      currentFolder = null;
    });
    panel.webview.onDidReceiveMessage((m) => void onMessage(m));
    panel.webview.html = buildHtml(raw, panel.webview); // posts 'ready' once loaded
  } else {
    panel.reveal(vscode.ViewColumn.Active);
    await postModel();
  }
  panel.title = folder ? `Stage Graph — ${folder}` : 'Stage Graph';
}

/** Repaint the open panel (driven by the status.json watcher). No-op when closed. */
export async function refreshStageGraph(): Promise<void> {
  await postModel();
}
