import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executionKey } from '../../../src/sessions.mjs';
import { INSTANCE_ROOT } from '../../../src/paths.mjs';
import { DurableInbox, QueuedCoordinator } from '../src/durable-inbox.mjs';

async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(5); }
  throw new Error('Queue test timed out');
}
class Network extends EventEmitter {
  constructor() { super(); this.runs = new Map(); this.busy = new Map(); this.calls = []; }
  async delegate(request) {
    const run = { ...request, runId: crypto.randomUUID(), agentId: request.target, status: 'running' };
    run.settled = new Promise(resolve => { run.done = resolve; });
    this.runs.set(run.runId, run); this.busy.set(executionKey(run.agentId, run.sessionKey), run.runId); this.calls.push(run); return run;
  }
  async getResult(id) { const run = this.runs.get(id); if (!run) throw new Error('Unknown run'); return run; }
  activeRun(id, sessionKey) { return this.runs.get(this.busy.get(executionKey(id, sessionKey))); }
  async send(request) { return { accepted: true, messageId: request.messageId }; }
  complete(run) { run.status = 'completed'; run.answer = 'done'; this.busy.delete(executionKey(run.agentId, run.sessionKey)); run.done(); }
}
async function setup(t, options = {}) {
  const base = resolve(INSTANCE_ROOT, '.local/tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(resolve(base, 'queue-'));
  const inbox = await DurableInbox.open(directory); const network = new Network(); const delivered = [];
  const worker = new QueuedCoordinator(network, inbox, { deliver: async item => { delivered.push(item.id); }, ...options });
  t.after(async () => { await worker.close(); for (const run of network.runs.values()) network.complete(run); await worker.running; await rm(directory, { recursive: true, force: true }); });
  const add = async (messageId, chatid = 'owner') => (await inbox.add({ messageId, agentId:'assistant', userid: 'owner', chatid, body:{chattype:'group'}, message: messageId, files: [] })).item;
  return { directory, inbox, network, worker, delivered, add };
}
test('messages survive reopening, deduplicate by message ID and keep received order', async t => {
  const f = await setup(t); const a = await f.add('a'); await f.add('b');
  const fresh = await DurableInbox.open(f.directory);
  assert.equal(fresh.next().id, a.id);
  assert.equal((await fresh.add({ messageId: 'a' })).created, false);
  assert.equal(fresh.items.size, 2);
});
test('the scheduler cannot consume an input before durable admission or after admission fails', async t => {
  const f=await setup(t);let reject;const gate=new Promise((_, fail)=>{reject=fail;});
  f.inbox.save=()=>gate;
  const admission=f.add('not durable');await f.worker.kick();assert.equal(f.network.calls.length,0);
  reject(new Error('disk unavailable'));await assert.rejects(admission,/disk unavailable/);
  await f.worker.kick();assert.equal(f.network.calls.length,0);assert.equal(f.inbox.items.size,0);
});
test('conversation capacity is bounded; different chats progress concurrently with one shared identity', async t => {
  const f = await setup(t, { maxConcurrent: 2 });
  await f.add('a', 'group-a'); await f.add('b', 'group-b'); await f.add('c', 'private');
  const draining = f.worker.kick(); await until(() => f.network.calls.length === 2);
  assert.equal(f.network.busy.size, 2);
  assert.deepEqual(f.network.calls.map(x => x.agentId), ['assistant','assistant']);
  f.network.complete(f.network.calls[1]);
  await until(() => f.network.calls.length === 3); assert.equal(f.network.calls[0].status, 'running');
  f.network.complete(f.network.calls[0]); f.network.complete(f.network.calls[2]); await draining;
  assert.deepEqual(f.inbox.counts(), { completed: 3 });
});
test('consumed supplements complete with their parent; unconsumed supplements stay queued', async t => {
  const f = await setup(t); await f.add('main'); void f.worker.kick();
  await until(() => [...f.worker.active.values()].some(x => x.runId));
  const supplement = await f.add('supplement'); await f.worker.enqueue(supplement);
  await until(() => supplement.status === 'attached');
  f.network.emit('injected', { runId: supplement.runId, messages: [{ id: supplement.id }] });
  f.network.complete(f.network.calls[0]); await f.worker.running;
  assert.equal(supplement.status, 'completed'); assert.equal(f.network.calls.length, 1);
  await f.add('second'); void f.worker.kick(); await until(() => f.network.calls.length === 2);
  const late = await f.add('not consumed'); await f.worker.enqueue(late);
  f.network.complete(f.network.calls[1]); await until(() => f.network.calls.length === 3);
  assert.ok(f.network.calls[2].message.includes('not consumed'));
  f.network.complete(f.network.calls[2]); await f.worker.running;
});
test('interrupted execution resumes from the durable entry after a process restart', async t => {
  const f = await setup(t); const item = await f.add('unfinished'); void f.worker.kick();
  await until(() => item.runId); await f.worker.close();
  const inbox = await DurableInbox.open(f.directory); const network = new Network(); await inbox.recover(network);
  const worker = new QueuedCoordinator(network, inbox, { deliver: async () => {} });
  void worker.kick(); await until(() => network.calls.length === 1);
  assert.ok(network.calls[0].message.includes('中断后的恢复'));
  network.complete(network.calls[0]); await worker.running; await worker.close();
  assert.equal(inbox.items.get(item.id).status, 'completed');
});
test('a failed reply is retried from the saved result without another model execution', async t => {
  const f = await setup(t); const item = await f.add('complete but unsent');
  f.worker.deliver = async () => { throw new Error('offline'); };
  void f.worker.kick(); await until(() => item.runId); f.network.complete(f.network.calls[0]); await f.worker.running;
  assert.equal(item.status, 'reply_pending'); await f.worker.close();
  const inbox = await DurableInbox.open(f.directory); await inbox.recover(f.network);
  const worker = new QueuedCoordinator(f.network, inbox, { deliver: async () => {} });
  await worker.kick(); await worker.close();
  assert.equal(inbox.items.get(item.id).status, 'completed'); assert.equal(f.network.calls.length, 1);
});

test('a supplement received during startup joins the current task and hook consumption cannot race durable registration', async t => {
  let release; const gate=new Promise(resolve=>{release=resolve;});
  const f=await setup(t,{prepare:()=>gate});
  const main=await f.add('main');void f.worker.kick();await until(()=>f.worker.active.size===1);
  const supplement=await f.add('during startup');await f.worker.enqueue(supplement);
  f.network.send=async request=>{
    assert.equal(supplement.status,'attached');
    f.network.emit('injected',{runId:request.expectedRunId,messages:[{id:request.messageId}]});
    return {accepted:true,messageId:request.messageId};
  };
  release();await until(()=>supplement.consumed);
  assert.equal(main.runId,supplement.runId);f.network.complete(f.network.calls[0]);await f.worker.running;
  assert.equal(f.network.calls.length,1);assert.equal(supplement.status,'completed');
});

test('a failed delivery blocks only its conversation, while other chats can finish', async t => {
  const f=await setup(t);const a=await f.add('A','group-a');const b=await f.add('B','group-b');
  f.worker.deliver=async item=>{if(item.id===a.id)throw new Error('A offline');};
  void f.worker.kick();await until(()=>a.runId&&b.runId);
  f.network.complete(f.network.runs.get(a.runId));await until(()=>a.status==='reply_pending'&&f.worker.blocked.size===1);
  f.network.complete(f.network.runs.get(b.runId));await f.worker.running;
  assert.equal(a.status,'reply_pending');assert.equal(b.status,'completed');
  f.worker.deliver=async()=>{};await f.worker.resume();assert.equal(a.status,'completed');assert.equal(f.network.calls.length,2);
});

test('restart resumes several interrupted conversations independently without discarding a supplement', async t => {
  const f=await setup(t);const a=await f.add('A','group-a');const b=await f.add('B','group-b');
  void f.worker.kick();await until(()=>a.runId&&b.runId);
  const supplement=await f.add('more A','group-a');await f.worker.enqueue(supplement);await until(()=>supplement.status==='attached');
  await f.worker.close();const inbox=await DurableInbox.open(f.directory);const network=new Network();await inbox.recover(network);
  const worker=new QueuedCoordinator(network,inbox,{deliver:async()=>{}});void worker.kick();
  await until(()=>network.calls.length===2&&inbox.items.get(supplement.id).status==='attached');
  assert.equal(new Set(network.calls.map(x=>x.sessionKey)).size,2);
  const restoredSupplement=inbox.items.get(supplement.id);
  network.emit('injected',{runId:restoredSupplement.runId,messages:[{id:restoredSupplement.id}]});
  for(const run of network.calls)network.complete(run);await worker.running;await worker.close();
  assert.deepEqual(inbox.counts(),{completed:3});
});
