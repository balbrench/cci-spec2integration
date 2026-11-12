import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHooks, removeHooks, installedHook, hookUrl } from '../src/hookInstall.ts';
import { TOKEN_HEADER } from '../src/hookServerCore.ts';

const existing = JSON.stringify({
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }] }],
  },
});

test('installing into a missing or empty file writes Stop and SubagentStop http hooks', () => {
  for (const text of [undefined, '', '  ']) {
    const out = JSON.parse(applyHooks(text, 4711, 'tok'));
    assert.deepEqual(Object.keys(out.hooks).sort(), ['Stop', 'SubagentStop']);
    const h = out.hooks.Stop[0].hooks[0];
    assert.equal(h.type, 'http');
    assert.equal(h.url, hookUrl(4711, 'Stop'));
    assert.equal(h.url, 'http://127.0.0.1:4711/spec2integration/hook/Stop');
    assert.equal(h.timeout, 5);
    assert.equal(h.headers[TOKEN_HEADER], 'tok');
    assert.equal(out.hooks.Stop[0].matcher, undefined, 'Stop takes no matcher');
  }
});

test('installing keeps the user\'s own settings and hooks', () => {
  const out = JSON.parse(applyHooks(existing, 4711, 'tok'));
  assert.deepEqual(out.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(out.hooks.Stop.length, 2);
  assert.equal(out.hooks.Stop[0].hooks[0].command, 'echo done');
  assert.equal(out.hooks.PreToolUse[0].hooks[0].command, 'check.sh');
});

test('re-installing with a new port replaces the old entries instead of adding more', () => {
  const once = applyHooks(existing, 1111, 'a');
  const twice = JSON.parse(applyHooks(once, 2222, 'b'));
  const urls = twice.hooks.Stop.flatMap((g: { hooks: { url?: string }[] }) => g.hooks.map((h) => h.url)).filter(Boolean);
  assert.deepEqual(urls, [hookUrl(2222, 'Stop')]);
  assert.deepEqual(installedHook(JSON.stringify(twice)), { port: 2222, token: 'b', events: ['Stop', 'SubagentStop'] });
});

test('removing restores the original settings exactly', () => {
  const installed = applyHooks(existing, 4711, 'tok');
  assert.deepEqual(JSON.parse(removeHooks(installed)), JSON.parse(existing));
  assert.equal(installedHook(removeHooks(installed)), undefined);
});

test('removing from a file with only the extension\'s hooks leaves no hooks key', () => {
  assert.deepEqual(JSON.parse(removeHooks(applyHooks(undefined, 1, 't'))), {});
});

test('an invalid settings file is never overwritten', () => {
  assert.throws(() => applyHooks('{ not json', 1, 't'), /left unchanged/);
  assert.throws(() => removeHooks('[1,2]'), /not a JSON object/);
  assert.equal(installedHook('{ not json'), undefined);
});
