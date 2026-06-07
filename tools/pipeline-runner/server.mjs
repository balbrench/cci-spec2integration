#!/usr/bin/env node
// Spec2Integration Pipeline Runner — standalone, zero-dependency.
//
// A small localhost server + UI that ACTUALLY RUNS the pipeline slash commands
// by shelling out to `claude -p "<command> <folder>"` (headless) and streaming
// the output back to the browser. It is a sibling of tools/vscode-extension/
// (which hosts the IR visualizer) and does NOT touch it.
//
// Design notes / honest limitations:
//   * Each run is a SEPARATE headless Claude Code session (claude -p). It is NOT
//     injected into your interactive VS Code chat — that capability isn't exposed
//     by Claude Code. Results stream into THIS UI's log pane instead.
//   * The headless session runs with cwd = repo root, so it loads CLAUDE.md,
//     .claude/commands/*, skills, and settings exactly like your normal session.
//   * Binds to 127.0.0.1 only. Commands are allow-listed; the folder argument is
//     strictly validated to a path under specs/. No arbitrary shell input.
//
// Run:  node tools/pipeline-runner/server.mjs [--port 8099] [--open]
// Then: http://127.0.0.1:8099/

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SPECS_ROOT = path.join(REPO_ROOT, 'specs');

// ---- config ----------------------------------------------------------------
const args = process.argv.slice(2);
const PORT = Number(getFlag('--port') ?? 8099);
const HOST = '127.0.0.1';

function getFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// Slash commands the runner is allowed to launch. Everything else is rejected.
const ALLOWED_COMMANDS = new Set([
  '/status', '/next', '/use', '/visualize', '/ir-diff', '/drift-check',
  '/clarify', '/model', '/contracts', '/map', '/architect',
  '/review', '/plan', '/tasks',
  '/test-mappings', '/test-flows',
  '/implement-azure', '/test-azure', '/deploy-azure',
  '/run-pipeline', '/prepare-for-implementation',
]);

const ALLOWED_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'auto', 'bypassPermissions']);

// A folder arg must look like specs/<...>/NNN-<slug> with no traversal or shell metachars.
const FOLDER_RE = /^specs[\/\\][A-Za-z0-9._\/\\-]+$/;

// ---- helpers ---------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(data);
}

function isSafeFolder(folder) {
  if (typeof folder !== 'string' || !FOLDER_RE.test(folder)) return false;
  const abs = path.resolve(REPO_ROOT, folder);
  if (!abs.startsWith(SPECS_ROOT)) return false;          // no escaping specs/
  return existsSync(abs);
}

async function readJson(absPath) {
  try { return JSON.parse(await readFile(absPath, 'utf-8')); }
  catch { return null; }
}

// Discover every integration folder: specs/NNN-slug and specs/<domain>/NNN-slug
async function discoverIntegrations() {
  const found = [];
  const isNnn = (name) => /^\d{3}-/.test(name);
  let level1;
  try { level1 = await readdir(SPECS_ROOT, { withFileTypes: true }); }
  catch { return found; }
  for (const e1 of level1) {
    if (!e1.isDirectory()) continue;
    const p1 = path.join(SPECS_ROOT, e1.name);
    if (isNnn(e1.name) && existsSync(path.join(p1, 'status.json'))) {
      found.push(path.posix.join('specs', e1.name));
      continue;
    }
    let level2 = [];
    try { level2 = await readdir(p1, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e2 of level2) {
      if (e2.isDirectory() && isNnn(e2.name) && existsSync(path.join(p1, e2.name, 'status.json'))) {
        found.push(path.posix.join('specs', e1.name, e2.name));
      }
    }
  }
  return found;
}

async function integrationSummary(folder) {
  const st = await readJson(path.join(REPO_ROOT, folder, 'status.json'));
  if (!st) return { folder, status: null };
  return {
    folder,
    generatedAt: st.generatedAt ?? null,
    activePlatform: st.activePlatform ?? null,
    next: st.next ?? null,
    counts: st.counts ?? null,
    stages: (st.stages ?? []).map(s => ({ id: s.id, name: s.name, status: s.status, summary: s.summary })),
  };
}

// Build the claude argv. Returns { exe, argv, display }.
function buildClaudeInvocation({ command, folder, permissionMode, model }) {
  const prompt = folder ? `${command} ${folder}` : command;
  const argv = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', permissionMode,
  ];
  if (model) argv.push('--model', model);
  // On Windows the launcher is claude.cmd; spawning a .cmd reliably needs shell:true.
  const exe = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const display = `claude -p ${JSON.stringify(prompt)} --output-format stream-json --verbose --permission-mode ${permissionMode}${model ? ` --model ${model}` : ''}`;
  return { exe, argv, display };
}

// ---- request handlers ------------------------------------------------------

async function handleApi(req, res, url) {
  // GET /api/integrations
  if (req.method === 'GET' && url.pathname === '/api/integrations') {
    const folders = await discoverIntegrations();
    const list = await Promise.all(folders.map(integrationSummary));
    return send(res, 200, { integrations: list });
  }

  // GET /api/status?folder=specs/...
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const folder = url.searchParams.get('folder');
    if (!isSafeFolder(folder)) return send(res, 400, { error: 'invalid or unknown folder' });
    const st = await readJson(path.join(REPO_ROOT, folder, 'status.json'));
    if (!st) return send(res, 404, { error: 'status.json not found' });
    return send(res, 200, st);
  }

  // POST /api/run  { command, folder, permissionMode?, model?, dryRun? }  -> SSE stream
  if (req.method === 'POST' && url.pathname === '/api/run') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch { return send(res, 400, { error: 'invalid JSON body' }); }

    const command = String(payload.command ?? '').trim();
    const folder = payload.folder ? String(payload.folder).trim() : '';
    const permissionMode = String(payload.permissionMode ?? 'acceptEdits');
    const model = payload.model ? String(payload.model).trim() : '';
    const dryRun = payload.dryRun === true;

    if (!ALLOWED_COMMANDS.has(command)) {
      return send(res, 400, { error: `command not allowed: ${command}` });
    }
    if (folder && !isSafeFolder(folder)) {
      return send(res, 400, { error: 'invalid or unknown folder' });
    }
    if (!ALLOWED_PERMISSION_MODES.has(permissionMode)) {
      return send(res, 400, { error: `invalid permissionMode: ${permissionMode}` });
    }
    if (model && !/^[A-Za-z0-9._\-\[\]]+$/.test(model)) {
      return send(res, 400, { error: 'invalid model token' });
    }

    const { exe, argv, display } = buildClaudeInvocation({ command, folder, permissionMode, model });

    // Start SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    sse('start', { command, folder, permissionMode, model: model || null, display, cwd: REPO_ROOT, dryRun });

    if (dryRun) {
      sse('log', { stream: 'info', line: 'DRY RUN — command not executed. Constructed invocation:' });
      sse('log', { stream: 'info', line: display });
      sse('done', { code: 0, dryRun: true });
      return res.end();
    }

    let child;
    try {
      child = spawn(exe, argv, {
        cwd: REPO_ROOT,
        shell: process.platform === 'win32', // .cmd launcher needs a shell on Windows
        env: process.env,
        windowsHide: true,
      });
    } catch (err) {
      sse('log', { stream: 'stderr', line: `failed to spawn claude: ${err.message}` });
      sse('done', { code: -1, error: err.message });
      return res.end();
    }

    // Forward stdout/stderr line-by-line. stdout is stream-json (one JSON event
    // per line); we forward raw lines plus a best-effort parsed shape.
    const pump = (streamName) => {
      let buf = '';
      return (chunk) => {
        buf += chunk.toString('utf-8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line.length === 0) continue;
          let parsed = null;
          if (streamName === 'stdout') { try { parsed = JSON.parse(line); } catch { /* not json */ } }
          sse('log', { stream: streamName, line, parsed });
        }
      };
    };
    child.stdout.on('data', pump('stdout'));
    child.stderr.on('data', pump('stderr'));

    const onClientClose = () => { try { child.kill(); } catch { /* ignore */ } };
    req.on('close', onClientClose);

    child.on('error', (err) => {
      sse('log', { stream: 'stderr', line: `process error: ${err.message}` });
    });
    child.on('close', (code) => {
      req.off('close', onClientClose);
      sse('done', { code });
      res.end();
    });
    return;
  }

  return send(res, 404, { error: 'not found' });
}

async function serveIndex(res) {
  try {
    const html = await readFile(path.join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('index.html missing next to server.mjs');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(res);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, async () => {
  const urlStr = `http://${HOST}:${PORT}/`;
  console.log(`Spec2Integration Pipeline Runner`);
  console.log(`  repo root : ${REPO_ROOT}`);
  console.log(`  listening : ${urlStr}`);
  const ints = await discoverIntegrations();
  console.log(`  found ${ints.length} integration folder(s): ${ints.join(', ') || '(none)'}`);
  console.log(`  Ctrl+C to stop.`);
  if (args.includes('--open')) {
    const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { spawn(opener, [urlStr], { shell: true, stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
  }
});
