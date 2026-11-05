import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpRuntime } from '../src/runtime-acp.mjs';

function prompt(t, { absolute, idle, acknowledge = true } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const events = [], notifications = [];
  const runtime = new AcpRuntime({ id: 'test', runtime: 'claude' }, {}, e => events.push(e));
  runtime.sessionId = 'origin'; runtime.config = { model: 'fixture', installation: { packages: {} } };
  let finish, fail;
  runtime.connection = {
    agent: {
      request: () => new Promise((resolve, reject) => { finish = stopReason => resolve({ stopReason }); fail = reject; }),
      async notify(method) { notifications.push(method); if (acknowledge) finish('cancelled'); }
    },
    close: () => fail(new Error('connection closed'))
  };
  const settled = runtime.run('work', [], absolute, idle);
  return { runtime, settled, events, notifications, finish,
    update: (update, sessionId = 'origin') => runtime.update({ sessionId, update }) };
}

test('an active ACP turn survives multiple idle windows, including private reasoning without recording it', async t => {
  const f = prompt(t, { idle: 900000 });
  t.mock.timers.tick(850000);
  f.update({ sessionUpdate: 'tool_call', toolCallId: 'a' });
  t.mock.timers.tick(850000);
  f.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private progress' } });
  t.mock.timers.tick(850000);
  f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' });
  f.finish('end_turn');
  const result = await f.settled;
  assert.equal(result.stopReason, 'end_turn'); assert.equal(result.cancellation, undefined);
  assert.ok(!f.events.some(e => e.sessionUpdate === 'agent_thought_chunk'));
  t.mock.timers.tick(2000000); assert.deepEqual(f.notifications, []);
});

test('usage, empty updates and activity from another session do not extend idle work', async t => {
  const f = prompt(t, { idle: 100 });
  f.update({ sessionUpdate: 'tool_call', toolCallId: 'previous', status: 'in_progress' });
  t.mock.timers.tick(65);
  f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'previous', status: 'in_progress' });
  f.update({ sessionUpdate: 'usage_update', used: 10 });
  f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'a' });
  f.update({ sessionUpdate: 'tool_call', toolCallId: 'other' }, 'other');
  t.mock.timers.tick(35);
  const r = await f.settled;
  assert.equal(r.stopReason, 'cancelled');
  assert.deepEqual(r.cancellation, { source: 'idle_timeout', limitMs: 100,
    requestedAt: new Date(1100).toISOString(), lastProgressAt: new Date(1000).toISOString() });
  assert.deepEqual(f.notifications, ['session/cancel']);
});

test('explicit wall deadline still wins with ongoing activity and a dropped cancellation reply', async t => {
  const f = prompt(t, { absolute: 100, idle: 80, acknowledge: false });
  t.mock.timers.tick(72); f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
  t.mock.timers.tick(28); await f.runtime.cancel('user_stop'); t.mock.timers.tick(10000);
  const r = await f.settled;
  assert.equal(r.cancellation.source, 'deadline'); assert.equal(r.cancellation.limitMs, 100);
  assert.equal(r.stopReason, 'cancelled'); assert.deepEqual(f.notifications, ['session/cancel']);
});

test('an explicit user stop and service shutdown keep their distinct origins', async t => {
  const f = prompt(t, { idle: 100 });
  await f.runtime.cancel('user_stop');
  const first = await f.settled; assert.equal(first.cancellation.source, 'user_stop');
  const second = f.runtime.run('again', [], undefined, 200);
  await f.runtime.cancel('service_shutdown'); const r = await second;
  assert.equal(r.cancellation.source, 'service_shutdown');
  assert.deepEqual(f.notifications, ['session/cancel', 'session/cancel']);
});

test('an unattributed adapter cancellation is not recorded as a user stop', async t => {
  const f = prompt(t);
  f.finish('cancelled');
  const r = await f.settled;
  assert.equal(r.cancellation.source, 'runtime_unspecified'); assert.deepEqual(f.notifications, []);
});
