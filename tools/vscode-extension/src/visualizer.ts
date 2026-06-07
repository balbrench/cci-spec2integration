// IR visualizer webview — hosts the bundled viewer (media/visualizer/index.html)
// in a panel and pushes data in over postMessage. The viewer is self-contained:
// it ships inside the extension (no dependency on a file in the user's workspace)
// and never fetches over the network — the extension reads the IR, status.json,
// and the validation report from disk and posts them in. See
// media/visualizer/index.html for the message contract.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { readStatus, IntegrationStatus } from './discovery';

let panel: vscode.WebviewPanel | undefined;
/** repo-relative folder the open panel is currently showing (for live refresh). */
let currentFolder: string | null = null;

/** Inject the webview CSP and point the vendored <script src="vendor/..."> tags
 *  at webview resource URIs. No remote origins; no network. */
function buildHtml(rawHtml: string, webview: vscode.Webview, vendorBase: string): string {
  const csp =
    `default-src 'none'; ` +
    `img-src ${webview.cspSource} data:; ` +
    `script-src ${webview.cspSource} 'unsafe-inline'; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `font-src ${webview.cspSource} data:; connect-src 'none';`;
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  let html = rawHtml.replace(/<head>/i, `<head>\n${cspMeta}`);
  html = html.replace(/src="vendor\//g, `src="${vendorBase}/`);
  return html;
}

/** Read <folder>/integration-ir.yaml, or null if absent. */
async function readIr(repoRoot: string, folder: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(repoRoot, folder, 'integration-ir.yaml'), 'utf-8');
  } catch {
    return null;
  }
}

/** Read <folder>/ir-validation-report.json, or null if absent / unparseable. */
async function readValidationReport(repoRoot: string, folder: string): Promise<unknown | null> {
  try {
    const text = await fs.readFile(path.join(repoRoot, folder, 'ir-validation-report.json'), 'utf-8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function openVisualizer(
  context: vscode.ExtensionContext,
  repoRoot: string,
  folder?: string | null,
): Promise<void> {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'visualizer');
  const htmlPath = vscode.Uri.joinPath(mediaRoot, 'index.html');
  let rawHtml: string;
  try {
    rawHtml = Buffer.from(await vscode.workspace.fs.readFile(htmlPath)).toString('utf-8');
  } catch {
    vscode.window.showErrorMessage('Bundled IR visualizer asset is missing (media/visualizer/index.html).');
    return;
  }

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'spec2integration.visualizer',
      'IR Visualizer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      },
    );
    panel.onDidDispose(() => {
      panel = undefined;
      currentFolder = null;
    });
  } else {
    panel.reveal(vscode.ViewColumn.Active);
  }

  currentFolder = folder ?? null;
  panel.title = folder ? `IR Visualizer — ${folder}` : 'IR Visualizer';
  const vendorBase = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vendor')).toString();
  panel.webview.html = buildHtml(rawHtml, panel.webview, vendorBase);

  if (!folder) return;

  const [ir, status, report] = await Promise.all([
    readIr(repoRoot, folder),
    readStatus(repoRoot, folder),
    readValidationReport(repoRoot, folder),
  ]);

  if (ir === null) {
    vscode.window.showInformationMessage(`No integration-ir.yaml in ${folder} yet.`);
    return;
  }
  // One combined message paints the graph, pill, and findings overlay at once.
  await panel.webview.postMessage({ type: 'load', ir, status: status ?? null, report: report ?? null });
}

/** Re-push status + findings to the open panel (driven by the status.json watcher).
 *  No-op when no panel is open or it has no folder. */
export async function refreshVisualizer(repoRoot: string): Promise<void> {
  if (!panel || !currentFolder) return;
  const [status, report] = await Promise.all([
    readStatus(repoRoot, currentFolder),
    readValidationReport(repoRoot, currentFolder),
  ]);
  await panel.webview.postMessage({ type: 'status', status: (status as IntegrationStatus | null) ?? null });
  await panel.webview.postMessage({ type: 'findings', report: report ?? null });
}
