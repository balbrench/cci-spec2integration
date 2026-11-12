import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DispatchTracker } from '../src/dispatchTracker.ts';

function clock() {
  let t = 1000;
  return { now: () => t, tick: (ms = 1) => (t += ms) };
}

test('the first Stop from any session claims an unbound dispatch and finishes it', () => {
  const c = clock();
  const tr = new DispatchTracker(c.now);
  const d = tr.record({ command: '/architect specs/x/001-a', folder: 'specs/x/001-a', stageId: '5' });
  assert.equal(d.command, '/architect');
  c.tick();
  const r = tr.handle({ hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'IR written' });
  assert.equal(r?.dispatch.id, d.id);
  assert.equal(r?.finished, true);
  assert.equal(d.sessionId, 's1');
  assert.equal(d.state, 'idle');
  assert.equal(d.lastMessage, 'IR written');
});

test('later Stops in the same session are not reported as a new finish', () => {
  const tr = new DispatchTracker();
  tr.record({ command: '/review f' });
  assert.equal(tr.handle({ hook_event_name: 'Stop', session_id: 's1' })?.finished, true);
  assert.equal(tr.handle({ hook_event_name: 'Stop', session_id: 's1' })?.finished, false);
});

test('SubagentStop records progress without finishing', () => {
  const tr = new DispatchTracker();
  const d = tr.record({ command: '/implement-azure f' });
  const r = tr.handle({ hook_event_name: 'SubagentStop', session_id: 's1', agent_type: 'azure-bicep-author' });
  assert.equal(r?.finished, false);
  assert.equal(d.state, 'running');
  assert.equal(d.lastAgent, 'azure-bicep-author');
  assert.equal(d.sessionId, 's1', 'SubagentStop also binds the session');
});

test('a dispatch sent to a known session only matches that session', () => {
  const c = clock();
  const tr = new DispatchTracker(c.now);
  const d = tr.record({ command: '/map f', sessionId: 'pinned' });
  c.tick();
  assert.equal(tr.handle({ hook_event_name: 'Stop', session_id: 'other' }), undefined);
  assert.equal(d.state, 'running');
  assert.equal(tr.handle({ hook_event_name: 'Stop', session_id: 'pinned' })?.dispatch.id, d.id);
});

test('a newer command run in the same session supersedes the older dispatch', () => {
  const c = clock();
  const tr = new DispatchTracker(c.now);
  const a = tr.record({ command: '/model f' });
  c.tick();
  tr.handle({ hook_event_name: 'Stop', session_id: 's1' });
  c.tick();
  const b = tr.record({ command: '/contracts f' });
  c.tick();
  const r = tr.handle({ hook_event_name: 'Stop', session_id: 's1' });
  assert.equal(r?.dispatch.id, b.id);
  assert.equal(r?.finished, true);
  assert.equal(a.state, 'idle');
});

test('events without a session, other event types, or nothing pending are ignored', () => {
  const tr = new DispatchTracker();
  assert.equal(tr.handle({ hook_event_name: 'Stop', session_id: 's1' }), undefined, 'nothing dispatched');
  tr.record({ command: '/plan f' });
  assert.equal(tr.handle({ hook_event_name: 'Stop' }), undefined);
  assert.equal(tr.handle({ hook_event_name: 'PreToolUse', session_id: 's1' }), undefined);
});

test('only the most recent dispatches are kept', () => {
  const tr = new DispatchTracker(Date.now, 3);
  for (let i = 0; i < 5; i++) tr.record({ command: `/c${i}` });
  assert.deepEqual(tr.list().map((d) => d.command), ['/c4', '/c3', '/c2']);
});
