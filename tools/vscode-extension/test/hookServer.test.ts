import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { startHookServer, HOOK_PATH_PREFIX, TOKEN_HEADER } from '../src/hookServerCore.ts';

function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('a Stop event with the token reaches the handler and gets an empty 204', async () => {
  const seen: Record<string, unknown>[] = [];
  const srv = await startHookServer({ token: 'tok', onEvent: (e) => void seen.push(e) });
  try {
    const r = await post(srv.port, `${HOOK_PATH_PREFIX}Stop`, JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }), {
      [TOKEN_HEADER]: 'tok',
    });
    assert.equal(r.status, 204);
    assert.equal(r.body, '');
    assert.equal(seen[0].session_id, 's1');
  } finally {
    await srv.close();
  }
});

test('a handler result is returned as JSON (for PreToolUse decisions)', async () => {
  const decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } };
  const srv = await startHookServer({ token: 'tok', onEvent: () => decision });
  try {
    const r = await post(srv.port, `${HOOK_PATH_PREFIX}PreToolUse`, '{"tool_name":"Write"}', { [TOKEN_HEADER]: 'tok' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), decision);
  } finally {
    await srv.close();
  }
});

test('the event name falls back to the URL path', async () => {
  let name: unknown;
  const srv = await startHookServer({ token: 'tok', onEvent: (e) => void (name = e.hook_event_name) });
  try {
    await post(srv.port, `${HOOK_PATH_PREFIX}SubagentStop`, '{}', { [TOKEN_HEADER]: 'tok' });
    assert.equal(name, 'SubagentStop');
  } finally {
    await srv.close();
  }
});

test('requests without the token, with a foreign Host, bad JSON or a wrong path are refused', async () => {
  let calls = 0;
  const srv = await startHookServer({ token: 'tok', onEvent: () => void calls++ });
  try {
    const p = `${HOOK_PATH_PREFIX}Stop`;
    assert.equal((await post(srv.port, p, '{}')).status, 401);
    assert.equal((await post(srv.port, p, '{}', { [TOKEN_HEADER]: 'wrong' })).status, 401);
    assert.equal((await post(srv.port, p, '{}', { [TOKEN_HEADER]: 'tok', host: 'evil.example:80' })).status, 403);
    assert.equal((await post(srv.port, p, 'not json', { [TOKEN_HEADER]: 'tok' })).status, 400);
    assert.equal((await post(srv.port, p, '[1]', { [TOKEN_HEADER]: 'tok' })).status, 400);
    assert.equal((await post(srv.port, '/other', '{}', { [TOKEN_HEADER]: 'tok' })).status, 404);
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test('a throwing handler gives a 500, never a decision', async () => {
  const srv = await startHookServer({
    token: 'tok',
    onEvent: () => {
      throw new Error('bug');
    },
  });
  try {
    const r = await post(srv.port, `${HOOK_PATH_PREFIX}Stop`, '{}', { [TOKEN_HEADER]: 'tok' });
    assert.equal(r.status, 500);
    assert.equal(r.body, '');
  } finally {
    await srv.close();
  }
});

test('the preferred port is used when free, and a taken one falls back to a free port', async () => {
  const first = await startHookServer({ token: 't', onEvent: () => undefined });
  try {
    const second = await startHookServer({ token: 't', port: first.port, onEvent: () => undefined });
    assert.notEqual(second.port, first.port);
    const p = second.port;
    await second.close();
    const third = await startHookServer({ token: 't', port: p, onEvent: () => undefined });
    assert.equal(third.port, p);
    await third.close();
  } finally {
    await first.close();
  }
});
