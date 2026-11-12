// Extension-side status refresh: runs scripts/refresh-status.ps1 when files in
// an integration folder change, so status.json stays current even when Claude
// Code's PostToolUse hook doesn't run (a managed allowManagedHooksOnly policy
// drops project hooks) and for edits the hook never sees (shell writes, git,
// edits outside Claude Code). Scheduling lives in statusRefreshCore.ts.
//
// Setting: spec2integration.autoRefreshStatus (default on).

import * as vscode from 'vscode';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { ALL, RefreshScheduler, refreshTargetFor } from './statusRefreshCore';
import { discoverIntegrations } from './discovery';

const REFRESHED_BY = 'auto:extension-watcher';
const DELAY_MS = 1500;

let output: vscode.OutputChannel | undefined;
let warnedMissingShell = false;

function log(line: string): void {
  output ??= vscode.window.createOutputChannel('Spec2Integration');
  output.appendLine(`[${new Date().toISOString()}] ${line}`);
}

export function autoRefreshEnabled(): boolean {
  return vscode.workspace.getConfiguration('spec2integration').get<boolean>('autoRefreshStatus', true);
}

function runScript(repoRoot: string, script: string, folder: string): Promise<void> {
  const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const args = ['-NoProfile', ...(process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []),
    '-File', script, '-Folder', folder, '-RefreshedBy', REFRESHED_BY];
  return new Promise((resolve, reject) => {
    execFile(shell, args, { cwd: repoRoot, timeout: 120_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) {
        log(`refreshed ${folder}/status.json`);
        return resolve();
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !warnedMissingShell) {
        warnedMissingShell = true;
        void vscode.window.showWarningMessage(
          `Spec2Integration: cannot run ${shell}, so status.json is not refreshed automatically. Install PowerShell${process.platform === 'win32' ? '' : ' 7 (pwsh)'} or turn off spec2integration.autoRefreshStatus.`,
        );
      }
      log(`refresh of ${folder} failed: ${(stderr || err.message).trim()}`);
      reject(err);
    });
  });
}

/** Start watching. Returns a disposable that stops the watcher and pending runs. */
export function startStatusRefresher(repoRoot: string): vscode.Disposable {
  const script = path.join(repoRoot, 'scripts', 'refresh-status.ps1');
  const scheduler = new RefreshScheduler({
    delayMs: DELAY_MS,
    run: async (target) => {
      if (!autoRefreshEnabled()) return;
      if (!existsSync(script)) {
        log(`skipped: ${path.relative(repoRoot, script)} not found`);
        return;
      }
      const folders = target === ALL ? await discoverIntegrations(repoRoot) : [target];
      for (const f of folders) {
        if (!existsSync(path.join(repoRoot, f, 'spec.md')) && !existsSync(path.join(repoRoot, f, 'status.json'))) continue;
        await runScript(repoRoot, script, f).catch(() => undefined);
      }
    },
  });

  const onChange = (uri: vscode.Uri) => {
    if (!autoRefreshEnabled()) return;
    const target = refreshTargetFor(path.relative(repoRoot, uri.fsPath));
    if (target) scheduler.touch(target);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(repoRoot, '{specs/**,.spec2integration/state.json}'),
  );
  watcher.onDidCreate(onChange);
  watcher.onDidChange(onChange);
  watcher.onDidDelete(onChange);

  return {
    dispose: () => {
      watcher.dispose();
      scheduler.dispose();
    },
  };
}
