// Live pipeline progress webview.
//
// A compact, read-only cockpit for one integration: an N-of-M progress bar, the
// stage list with status + summary, Sev/stale badges, coverage, blocked-flow
// ids, per-stage timings, a generated-artifacts summary, and open-links to each
// stage's artifact/report. Self-contained (no network); the extension reads
// status.json from disk, enriches it, and posts it over postMessage. Re-pushes
// on the file watchers so it tracks the pipeline live.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  discoverIntegrations,
  discoverPreIntegrations,
  readState,
  readStatus,
  IntegrationStatus,
  Stage,
  PreIntegration,
} from './discovery';
import { STAGE_CMD } from './commandCatalog';
import { resolveArtifact, resolveReport, openPath } from './artifacts';

let panel: vscode.WebviewPanel | undefined;
let currentFolder: string | null = null;
let currentRepoRoot = '';

/** Per-stage open targets the webview can open via a message. `artifact`/`report`
 *  are folder-relative paths; `url` is an external (deployed-app) URL. */
interface StageLinks {
  [stageId: string]: { artifact?: string; report?: string; url?: string };
}

/** Summary of what the implement stage produced, for the "Generated artifacts" panel. */
interface GeneratedArtifacts {
  workflows: number;
  connections: boolean;
  infraModules: number;
  testProjects: number;
  cicd: number;
  functions: number;
  total?: number;
}

function buildHtml(rawHtml: string, webview: vscode.Webview): string {
  const csp =
    `default-src 'none'; ` +
    `img-src ${webview.cspSource} data:; ` +
    `script-src ${webview.cspSource} 'unsafe-inline'; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `font-src ${webview.cspSource} data:; connect-src 'none';`;
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return rawHtml.replace(/<head>/i, `<head>\n${cspMeta}`);
}

/** The folder to show: explicit → active → first discovered. */
async function resolveFolder(repoRoot: string, explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  const state = await readState(repoRoot);
  if (state.activeIntegration) return state.activeIntegration;
  const all = await discoverIntegrations(repoRoot);
  return all[0] ?? null;
}

/** Map status.next.command to the stage row it advances — same rule as the tree,
 *  so the webview highlight and the tree agree on "next". */
function nextStageId(status: IntegrationStatus): string | undefined {
  const cmd = status.next?.command?.split(/\s+/)[0];
  if (!cmd) return undefined;
  const stages = status.stages ?? [];
  for (const s of stages) {
    if (STAGE_CMD[s.id] === cmd && (s.status === 'missing' || s.status === 'stale' || s.status === 'blocked')) {
      return s.id;
    }
  }
  for (const s of stages) if (STAGE_CMD[s.id] === cmd) return s.id;
  return undefined;
}

async function countFiles(dir: string, predicate: (name: string) => boolean): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && predicate(e.name)).length;
  } catch {
    return 0;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Count `app/<flow>/workflow.json` files. */
async function countWorkflows(appDir: string): Promise<number> {
  let n = 0;
  try {
    const entries = await fs.readdir(appDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && (await exists(path.join(appDir, e.name, 'workflow.json')))) n++;
    }
  } catch {
    /* no app dir */
  }
  return n;
}

/** Count csproj files under tests-mstest (root + one level of project subfolders). */
async function countCsproj(testsDir: string): Promise<number> {
  let n = 0;
  try {
    const entries = await fs.readdir(testsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.csproj')) n++;
      else if (e.isDirectory()) n += await countFiles(path.join(testsDir, e.name), (f) => f.endsWith('.csproj'));
    }
  } catch {
    /* no tests dir */
  }
  return n;
}

/** Summarise generated output for the panel. Returns null when nothing has been generated yet. */
async function generatedArtifacts(repoRoot: string, folder: string, status: IntegrationStatus): Promise<GeneratedArtifacts | null> {
  const base = path.join(repoRoot, folder);
  const appDir = path.join(base, 'app');
  const [workflows, connections, infraMain, infraModules, testProjects, cicd, functions] = await Promise.all([
    countWorkflows(appDir),
    exists(path.join(appDir, 'connections.json')),
    exists(path.join(base, 'infra', 'main.bicep')),
    countFiles(path.join(base, 'infra', 'modules'), (f) => f.endsWith('.bicep')),
    countCsproj(path.join(base, 'tests-mstest')),
    countFiles(path.join(appDir, '.github', 'workflows'), (f) => f.endsWith('.yml') || f.endsWith('.yaml')),
    countFiles(path.join(base, 'Functions'), (f) => f.endsWith('.csproj')),
  ]);
  const modules = infraModules + (infraMain ? 1 : 0);
  if (!workflows && !connections && !modules && !testProjects && !cicd && !functions) return null;
  return {
    workflows,
    connections,
    infraModules: modules,
    testProjects,
    cicd,
    functions,
    total: status.lastImplement?.artifactCount,
  };
}

/** Resolve artifact + report open-targets for every stage row. */
async function stageLinks(repoRoot: string, folder: string, stages: Stage[]): Promise<StageLinks> {
  const links: StageLinks = {};
  await Promise.all(
    stages.map(async (s) => {
      const [artifact, report] = await Promise.all([
        resolveArtifact(repoRoot, folder, s.id),
        resolveReport(repoRoot, folder, s.id),
      ]);
      // Deploy (12): surface the live URL from the summary as an external link.
      let url: string | undefined;
      if (s.id === '12' && s.status === 'done') {
        const m = (s.summary || '').match(/https?:\/\/[^\s)]+/);
        if (m) url = m[0].replace(/[.,;]+$/, '');
      }
      if (artifact || report || url) links[s.id] = { artifact, report, url };
    }),
  );
  return links;
}

/** Build the enriched message payload for an integration and post it. */
async function postIntegration(
  repoRoot: string,
  type: 'load' | 'status',
  folder: string,
  status: IntegrationStatus | null,
): Promise<void> {
  if (!panel) return;
  const stages = status?.stages ?? [];
  const [links, artifacts] = status
    ? await Promise.all([stageLinks(repoRoot, folder, stages), generatedArtifacts(repoRoot, folder, status)])
    : [{}, null];
  await panel.webview.postMessage({
    type,
    folder,
    status: status ?? null,
    nextStageId: status ? nextStageId(status) : undefined,
    links,
    artifacts,
  });
}

export async function openProgress(
  context: vscode.ExtensionContext,
  repoRoot: string,
  folder?: string | null,
): Promise<void> {
  currentRepoRoot = repoRoot;
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'progress');
  const htmlPath = vscode.Uri.joinPath(mediaRoot, 'index.html');
  let rawHtml: string;
  try {
    rawHtml = Buffer.from(await vscode.workspace.fs.readFile(htmlPath)).toString('utf-8');
  } catch {
    vscode.window.showErrorMessage('Bundled progress view asset is missing (media/progress/index.html).');
    return;
  }

  if (!panel) {
    panel = vscode.window.createWebviewPanel('spec2integration.progress', 'Pipeline Progress', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    panel.onDidDispose(() => {
      panel = undefined;
      currentFolder = null;
    });
    // Open a stage's artifact / report (or the IR visualizer) from the webview.
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      if (msg.type === 'openUrl' && typeof msg.url === 'string') {
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      }
      if (!currentFolder) return;
      if (msg.type === 'open' && typeof msg.rel === 'string') {
        if (/integration-ir\.ya?ml$/i.test(msg.rel)) {
          await vscode.commands.executeCommand('spec2integration.openVisualizer');
        } else {
          await openPath(currentRepoRoot, currentFolder, msg.rel);
        }
      }
    });
  } else {
    panel.reveal(vscode.ViewColumn.Active);
  }

  panel.webview.html = buildHtml(rawHtml, panel.webview);

  const resolved = await resolveFolder(repoRoot, folder);
  const status = resolved ? await readStatus(repoRoot, resolved) : null;

  // No numbered integration (or its status.json is unreadable) — surface the
  // BizTalk pre-integration phase if one exists, so the panel is never a dead end.
  if (!status) {
    const pres = await discoverPreIntegrations(repoRoot);
    const pre = pres.find((p) => p.folder === resolved) ?? pres[0] ?? null;
    if (pre) {
      currentFolder = null; // mark pre-phase so refreshProgress re-evaluates
      panel.title = `Pipeline Progress — ${pre.folder.split('/').pop()}`;
      await panel.webview.postMessage({ type: 'load', folder: null, status: null, pre });
      return;
    }
  }

  currentFolder = resolved;
  panel.title = currentFolder ? `Pipeline Progress — ${currentFolder.split('/').pop()}` : 'Pipeline Progress';
  if (currentFolder) {
    await postIntegration(repoRoot, 'load', currentFolder, status);
  } else {
    await panel.webview.postMessage({ type: 'load', folder: null, status: null });
  }
}

/** Re-push status to the open progress panel (driven by the file watchers). */
export async function refreshProgress(repoRoot: string): Promise<void> {
  if (!panel) return;
  currentRepoRoot = repoRoot;
  if (currentFolder) {
    const status: IntegrationStatus | null = await readStatus(repoRoot, currentFolder);
    await postIntegration(repoRoot, 'status', currentFolder, status);
    return;
  }
  // Pre-integration phase: if reverse-engineering has since produced a real
  // integration, switch to it; otherwise re-push the latest pre-integration card.
  const resolved = await resolveFolder(repoRoot, null);
  if (resolved) {
    currentFolder = resolved;
    const status: IntegrationStatus | null = await readStatus(repoRoot, resolved);
    await postIntegration(repoRoot, 'status', resolved, status);
    return;
  }
  const pres: PreIntegration[] = await discoverPreIntegrations(repoRoot);
  await panel.webview.postMessage({ type: 'status', folder: null, status: null, pre: pres[0] ?? null });
}
