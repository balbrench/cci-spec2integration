// Hook listener — a localhost HTTP endpoint for Claude Code `http` hooks
// (Phase 4, Change 0b).
//
// Claude Code POSTs the hook's JSON input (the same JSON a command hook reads
// on stdin) to http://127.0.0.1:<port>/spec2integration/hook/<Event>. A 2xx
// with an empty body means "no decision"; a 2xx JSON body is read with the
// command-hook output schema (used later for PreToolUse decisions). A refused
// connection or a timeout is a non-blocking error for Claude Code, so a closed
// VS Code never stops a session. Source: code.claude.com/docs/en/hooks.md.
//
// Every request must carry the per-workspace token header and a Host header
// naming the loopback address, so other local processes and web pages (DNS
// rebinding) can't post events.
//
// No `vscode` import: unit-tested in plain Node.

import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const HOOK_PATH_PREFIX = '/spec2integration/hook/';
export const TOKEN_HEADER = 'x-spec2integration-token';
const MAX_BODY = 1024 * 1024;

export interface HookServerOptions {
  token: string;
  /** Preferred port; 0 or unavailable falls back to a free one. */
  port?: number;
  /** Return undefined for "no decision" (empty 204), or a JSON-serialisable hook output. */
  onEvent(event: Record<string, unknown>): unknown | Promise<unknown>;
}

export interface HookServer {
  port: number;
  close(): Promise<void>;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function handler(opts: HookServerOptions, portRef: { port: number }): http.RequestListener {
  return (req, res) => {
    const reply = (code: number, body?: unknown) => {
      if (body === undefined) {
        res.writeHead(code).end();
      } else {
        res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      }
    };

    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${portRef.port}` && host !== `localhost:${portRef.port}`) return reply(403);
    if (req.method !== 'POST' || !req.url?.startsWith(HOOK_PATH_PREFIX)) return reply(404);
    const token = req.headers[TOKEN_HEADER];
    if (typeof token !== 'string' || !sameToken(token, opts.token)) return reply(401);

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY && !aborted) {
        aborted = true;
        reply(413);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let event: unknown;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        return reply(400);
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return reply(400);
      const ev = event as Record<string, unknown>;
      // The path names the event; trust it only when the body doesn't.
      if (typeof ev.hook_event_name !== 'string') {
        ev.hook_event_name = decodeURIComponent(req.url!.slice(HOOK_PATH_PREFIX.length).split(/[/?]/)[0]);
      }
      Promise.resolve()
        .then(() => opts.onEvent(ev))
        .then(
          (out) => reply(out === undefined ? 204 : 200, out),
          // A handler bug must never turn into a decision; 500 is non-blocking.
          () => reply(500),
        );
    });
  };
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as { port: number }).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** Start the listener on 127.0.0.1, preferring `opts.port`. */
export async function startHookServer(opts: HookServerOptions): Promise<HookServer> {
  const portRef = { port: 0 };
  const server = http.createServer(handler(opts, portRef));
  try {
    portRef.port = await listen(server, opts.port ?? 0);
  } catch (err) {
    if (!opts.port) throw err;
    portRef.port = await listen(server, 0); // preferred port taken: any free one
  }
  return {
    port: portRef.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
