import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executionKey } from '../../../src/sessions.mjs';
import { WecomBridge } from '../src/wecom.mjs';
import { incomingFiles, outgoingFiles, clipText } from '../src/wecom-files.mjs';
import { INSTANCE_ROOT, writeJson, readJson, within } from '../../../src/paths.mjs';
import { Catalog } from '../../../src/catalog.mjs';
import { AgentNetwork } from '../../../src/network.mjs';
import { restoreSharedAssistant } from '../src/wecom-routing.mjs';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(5); }
  throw new Error('Fixture did not reach expected state');
}

// Transport doubles: these tests do not claim delivery through WeCom.
async function fixture(t, allowedUserIds = [], id = 'assistant', name = id) {
  const base = resolve(INSTANCE_ROOT, '.local/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'wecom-')); const workspace = resolve(root, id); await mkdir(workspace);
  const network = new EventEmitter(); Object.assign(network, { busy: new Map(), runtimes: new Map(), runs: new Map(), sent: [], delegated: [] });
  await writeJson(resolve(root, 'network.json'), { workspaceRoot: 'workspaces',
    templates: { coordinator: { runtime: 'fake', instructions: 'coordinate', capabilities: ['coordinate'], manager: true } },
    coordinatorId: id, agents: { [id]: { template: 'coordinator', workspace, name } } });
  network.catalog = await Catalog.load(root); const agent = network.catalog.get(id);
  network.replyUser = AgentNetwork.prototype.replyUser;
  network.activeRun = AgentNetwork.prototype.activeRun; network.isBusy = AgentNetwork.prototype.isBusy; network.cancel = AgentNetwork.prototype.cancel;
  network.delegate = async request => {
    const target = network.catalog.get(request.target);
    const run = { ...request, runId: crypto.randomUUID(), agentId: target.id, workspace: target.workspace,
      startedAt: new Date().toISOString(), status: 'running', outputFiles: [] };
    run.settled = new Promise(resolve => { run.complete = resolve; });
    network.delegated.push(request); network.runs.set(run.runId, run); network.busy.set(executionKey(target.id, run.sessionKey), run.runId); return run;
  };
  network.send = async request => { const id = request.messageId ?? crypto.randomUUID(); network.sent.push({ ...request, id }); return { accepted: true, messageId: id }; };
  network.getResult = async id => { const run = network.runs.get(id); if (!run) throw new Error('Missing run'); return run; };
  network.complete = (run, result) => {
    Object.assign(run, { endedAt: new Date().toISOString(), status: 'completed', model: 'test-model' }, result);
    network.busy.delete(executionKey(run.agentId, run.sessionKey)); run.complete();
  };
  class Client extends EventEmitter {
    constructor() { super(); this.replies = []; this.mediaSent = []; }
    connect() { this.emit('authenticated'); }
    disconnect() {}
    async replyStream(frame, streamId, content, finish) { this.replies.push({ frame, streamId, content, finish }); return { errcode: 0 }; }
    async sendMessage(chatid, body) { this.replies.push({ chatid, content: body.markdown.content, finish: true }); return { errcode: 0 }; }
    async downloadFile() { return { buffer: Buffer.from('input'), filename: '../../outside.txt' }; }
    async uploadMedia() { return { media_id: 'test-media' }; }
    async sendMediaMessage(chatid, type, mediaId) { this.mediaSent.push({ chatid, type, mediaId }); return { errcode: 0 }; }
  }
  const client = new Client();
  const configFile = resolve(root, 'wecom.json');
  const config = { botId: 'test-bot', secret: 'TEST-SECRET-ONLY', pairingCode: 'ABC12345', agentId: agent.id, allowedUserIds };
  await writeJson(configFile, config);
  const bridge = new WecomBridge(network, client, config, { configFile, statusFile: resolve(root, 'status.json'), logFile: resolve(root, 'events.jsonl'), inboxDirectory: resolve(root, 'inbox') }).start();
  await bridge.ready;
  t.after(async () => {
    await bridge.close();
    for (const run of network.runs.values()) if (run.status === 'running') network.complete(run, { status: 'incomplete' });
    await bridge.worker.running; await bridge.statusQueue;
    await rm(root, { recursive: true, force: true });
  });
  const frame = (text, userid = 'owner', msgid = crypto.randomUUID(), chattype = 'single', chatid = 'test-group') => ({ headers: { req_id: crypto.randomUUID() },
    body: { aibotid: config.botId, from: { userid }, msgid, chattype, chatid: chattype === 'group' ? chatid : undefined,
      msgtype: 'text', text: { content: text } } });
  return { root, workspace, network, client, bridge, configFile, frame };
}

test('only the private pairing message binds an owner and dispatches the real coordinator entry', async t => {
  const f = await fixture(t);
  await f.bridge.receive(f.frame('hello', 'unknown'));
  assert.equal(f.network.delegated.length, 0); assert.equal(f.client.replies.length, 0);
  const binding = f.frame('「绑定：abc12345」'); binding.body.aibotid = 'callback-internal-id';
  await f.bridge.receive(binding);
  await until(() => f.network.delegated.length === 1);
  const saved = await readJson(f.configFile);
  assert.deepEqual(saved.allowedUserIds, ['owner']); assert.equal(saved.pairingCode, undefined);
  assert.equal(f.network.delegated.length, 1); assert.equal(f.network.delegated[0].target, 'assistant');
  assert.ok(!f.network.delegated[0].message.includes('ABC12345'));
  const run = [...f.network.runs.values()][0];
  f.network.complete(run, { answer: '连接成功' }); await f.bridge.worker.running;
  assert.equal(f.client.replies.at(-1).finish, true); assert.equal(f.bridge.status.lastReply.ackCode, 0);
});

test('owner follow-ups enter the active run; duplicates and other users do not execute work', async t => {
  const f = await fixture(t, ['owner']); const first = f.frame('do work');
  await f.bridge.receive(first); await until(() => f.network.delegated.length === 1); await f.bridge.receive(first);
  await f.bridge.receive(f.frame('extra context'));
  await f.bridge.receive(f.frame('untrusted request', 'stranger'));
  await f.bridge.receive(f.frame('group request', 'stranger', 'group-msg', 'group'));
  assert.equal(f.network.delegated.length, 1); await until(() => f.network.sent.length === 1);
  assert.match(f.network.sent[0].message, /extra context/);
});

test('incoming file names cannot escape the agent inbox', async t => {
  const f = await fixture(t, ['owner']);
  const files = await incomingFiles(f.client, { msgtype: 'file', msgid: 'file-1', file: { url: 'https://example.invalid/test', aeskey: 'test' } }, f.workspace);
  assert.ok(within(resolve(f.workspace, 'inbox'), files[0]));
  assert.equal(await readFile(files[0], 'utf8'), 'input');
});

test('only declared output files are sent; links outside the workspace are excluded', async t => {
  const f = await fixture(t, ['owner']);
  const report = resolve(f.workspace, 'report.txt'); const unrelated = resolve(f.workspace, 'old.txt');
  const outside = resolve(f.root, 'private.txt'); const link = resolve(f.workspace, 'linked.txt');
  await writeFile(report, 'report'); await writeFile(unrelated, 'old'); await writeFile(outside, 'private'); await symlink(outside, link);
  const run = { runId: 'r', agentId: 'assistant', workspace: f.workspace, startedAt: '2026-01-01', endedAt: '2026-01-02',
    outputFiles: [{ path: report }, { path: unrelated }, { path: link }] };
  const files = await outgoingFiles(f.network, run, `成果在 ${report} 和 ${link}`);
  assert.deepEqual(files.map(x => x.path), [report]);
  const clipped = clipText('中文🙂'.repeat(5000));
  assert.ok(Buffer.byteLength(clipped) < 20480); assert.ok(!clipped.includes('\ufffd'));
});

test('attachment lookup follows parent run IDs instead of overlapping coordinator timestamps', async t => {
  const f=await fixture(t,['owner']);const first=resolve(f.workspace,'first.txt');const second=resolve(f.workspace,'second.txt');
  await writeFile(first,'first task');await writeFile(second,'other task');
  const parent={runId:'parent-a',agentId:'assistant',workspace:f.workspace,startedAt:'2026-01-01',endedAt:'2026-01-02',outputFiles:[]};
  for(const [runId,parentRunId,path] of [['child-a','parent-a',first],['child-b','parent-b',second]])
    f.network.runs.set(runId,{runId,parentRunId,from:'assistant',startedAt:'2026-01-01',workspace:f.workspace,outputFiles:[{path}]});
  assert.deepEqual((await outgoingFiles(f.network,parent,`${first} ${second}`)).map(x=>x.path),[first]);
});

test('a slow attachment download does not delay another conversation', async t => {
  const f=await fixture(t,['owner']);let release;const gate=new Promise(resolve=>{release=resolve;});
  f.client.downloadFile=async()=>{await gate;return {buffer:Buffer.from('input'),filename:'input.txt'};};
  const file=f.frame('','owner','file-test','group','group-a');file.body.msgtype='file';file.body.file={url:'https://example.invalid/file',aeskey:'test'};
  try {
    await f.bridge.receive(file);await f.bridge.receive(f.frame('parallel text'));
    await until(()=>f.network.delegated.length===1);
    assert.match(f.network.delegated[0].sessionKey,/single:owner/);
  } finally {release();}
  await until(()=>f.network.delegated.length===2);
});

test('the first owner task silently enables a group; members cannot enable groups or enter private chat', async t => {
  const f = await fixture(t, ['owner']);
  const group = (text, user = 'owner') => f.frame(text, user, crypto.randomUUID(), 'group', 'group-a');
  await f.bridge.receive(group('@ExampleBot 启用本群', 'member'));
  await f.bridge.receive(group('task', 'member'));
  assert.equal(f.client.replies.length, 0); assert.equal(f.network.delegated.length, 0);
  await f.bridge.receive(group('@ExampleBot 帮我整理今天的安排'));
  assert.deepEqual((await readJson(f.configFile)).enabledGroupIds, ['group-a']);
  await until(() => [...f.bridge.worker.active.values()].some(x => x.runId));
  assert.equal(f.client.replies.length, 0);
  assert.match(f.network.delegated[0].message, /帮我整理今天的安排/);
  assert.equal(f.network.delegated[0].target, 'assistant');
  await f.bridge.receive(group('task', 'member'));
  assert.equal(f.network.delegated.length, 1);
  await until(() => f.network.sent.length === 1);
  assert.match(f.network.sent[0].message, /task/);
  await f.bridge.receive(f.frame('private task', 'member'));
  await f.bridge.receive(group('/停用本群', 'member'));
  assert.equal(f.network.delegated.length, 1);
  assert.deepEqual((await readJson(f.configFile)).enabledGroupIds, ['group-a']);
  await f.bridge.receive(group('@ExampleBot /停用本群'));
  await f.bridge.receive(group('another task', 'member'));
  assert.deepEqual((await readJson(f.configFile)).enabledGroupIds, []);
  assert.equal(f.network.sent.length, 1);
});

test('two groups and private chat execute together using one identity and workspace; supplements and replies stay scoped', async t => {
  const f = await fixture(t, ['owner']);
  const group = (text, chatid) => f.frame(text, 'owner', crypto.randomUUID(), 'group', chatid);
  await f.bridge.receive(group('task A', 'group-a')); await f.bridge.receive(group('task B', 'group-b'));
  await f.bridge.receive(f.frame('private task'));
  await until(() => f.network.delegated.length === 3 && [...f.bridge.worker.active.values()].every(x => x.runId));
  const [a,b,personal] = [...f.network.runs.values()];
  assert.deepEqual([...new Set([a.agentId,b.agentId,personal.agentId])], ['assistant']);
  assert.deepEqual([...new Set([a.workspace,b.workspace,personal.workspace])], [f.workspace]);
  assert.equal(new Set([a.sessionKey,b.sessionKey,personal.sessionKey]).size, 3);
  assert.equal(f.network.catalog.list().agents.length, 1);
  await f.bridge.receive(group('more context B','group-b'));
  await until(() => f.network.sent.length === 1);
  assert.equal(f.network.sent[0].expectedRunId, b.runId);
  f.network.emit('injected',{runId:b.runId,messages:[{id:f.network.sent[0].id}]});
  const file=resolve(f.workspace,'report-b.txt'); await writeFile(file,'B');
  f.network.complete(b,{answer:file,outputFiles:[{path:file}]});
  await until(() => f.client.mediaSent.length === 1);
  assert.equal(a.status,'running'); assert.equal(personal.status,'running');
  f.network.complete(personal,{answer:'private done'}); f.network.complete(a,{answer:'A done'});
  await f.bridge.worker.running;
  assert.deepEqual(f.client.mediaSent.map(x=>x.chatid),['group-b']);
  assert.equal(f.client.replies.find(x=>x.content==='private done').chatid,'owner');
  assert.equal(f.client.replies.find(x=>x.content==='A done').chatid,'group-a');
  assert.equal(f.network.delegated.length,3);
  assert.equal((await Catalog.load(f.root)).get('assistant').workspace,f.workspace);
});

test('queue, retry and stop controls affect only the source conversation while other chats remain active', async t => {
  const f=await fixture(t,['owner']);
  const group=(text,id)=>f.frame(text,'owner',crypto.randomUUID(),'group',id);
  await f.bridge.receive(group('task A','group-a')); await f.bridge.receive(group('task B','group-b'));
  await until(()=>f.network.delegated.length===2 && [...f.bridge.worker.active.values()].every(x=>x.runId));
  const [a,b]=[...f.network.runs.values()]; const canceled=[];
  for(const run of [a,b]) f.network.runtimes.set(executionKey('assistant',run.sessionKey),{cancel:async()=>canceled.push(run.runId)});
  await f.bridge.receive(group('/停止','group-b')); assert.deepEqual(canceled,[b.runId]);
  await f.bridge.receive(group('/队列','group-a')); assert.equal(f.client.replies.at(-1).content,'本会话待办状态：{"running":1}');
  await f.bridge.receive(f.frame('/状态')); assert.match(f.client.replies.at(-1).content,/同时处理/);
  const addFailed=async id=>(await f.bridge.inbox.add({messageId:crypto.randomUUID(),agentId:'assistant',chatid:id,body:{chattype:'group'},status:'failed',message:'failed task',files:[]})).item;
  const failedA=await addFailed('group-a'); const failedB=await addFailed('group-b');
  await f.bridge.receive(group('/重试','group-b')); assert.equal(failedA.status,'failed'); assert.equal(failedB.status,'pending');
  await f.bridge.receive(group('/停止','group-a')); assert.deepEqual(canceled,[b.runId,a.runId]);
});

test('legacy group history is retained and unfinished work moves to the shared assistant without changing its destination', async t => {
  const f = await fixture(t, ['owner']);
  const old = await f.network.catalog.create('coordinator', 'old-group-assistant', true, { scope: 'old-group' });
  const note = resolve(old.workspace, 'note.txt'); await writeFile(note, 'previous work');
  const run = await f.network.delegate({ target: old.id, message: 'old task' });
  f.network.complete(run, { answer: 'old result', outputFiles: [{ path: note }] });
  const complete = (await f.bridge.inbox.add({ messageId: 'old-completed', agentId: old.id, chatid: 'group-a',
    body: { chattype: 'group' }, message: 'old task', runId: run.runId, status: 'completed' })).item;
  const pending = (await f.bridge.inbox.add({ messageId: 'old-pending', agentId: old.id, chatid: 'group-a',
    body: { chattype: 'group' }, message: 'continue', status: 'pending' })).item;
  await restoreSharedAssistant(f.network, f.bridge.config, f.bridge.inbox);
  const history = await readJson(resolve(f.workspace, 'history/wecom-legacy.json'));
  assert.equal(history.entries[0].answer, 'old result');
  assert.equal(history.entries[0].workspace, old.workspace);
  assert.equal(complete.agentId, old.id, 'completed evidence retains its original execution identity');
  assert.equal(pending.agentId, 'assistant'); assert.equal(pending.previousAgentId, old.id);
  assert.equal(pending.chatid, 'group-a');
  assert.equal(await readFile(note, 'utf8'), 'previous work');
  await restoreSharedAssistant(f.network, f.bridge.config, f.bridge.inbox);
  assert.equal((await readJson(resolve(f.workspace, 'history/wecom-legacy.json'))).entries.length, 2);
});

test('the coordinator can reply before completion; messages stay in the source chat and the final record is not echoed', async t => {
  const f = await fixture(t, ['owner']);
  await f.bridge.receive(f.frame('task A', 'owner', 'reply-a', 'group', 'group-a'));
  await until(() => [...f.bridge.worker.active.values()].some(x => x.runId));
  const a = [...f.network.runs.values()][0];
  await f.bridge.receive(f.frame('task B', 'owner', 'reply-b', 'group', 'group-b'));
  let release; const gate = new Promise(resolve => { release = resolve; });
  const send = f.client.sendMessage.bind(f.client);
  f.client.sendMessage = async (...args) => { await gate; return send(...args); };
  let first; let second;
  try {
    first = await f.network.replyUser({ from: 'assistant', fromSessionKey: a.sessionKey, message: '阶段结果 A' });
    second = await f.network.replyUser({ from: 'assistant', fromSessionKey: a.sessionKey, message: '继续补充 A' });
    assert.equal(first.queued, true); assert.equal(second.queued, true);
    assert.equal(a.status, 'running'); assert.equal(f.client.replies.length, 0);
    f.network.emit('event', { runId: a.runId, sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '内部草稿' } });
  } finally { release(); }
  await f.bridge.outbox.flush([first.messageId, second.messageId]);
  assert.equal(a.status, 'running', 'delivery must precede task completion');
  assert.deepEqual(f.client.replies.map(r => [r.chatid, r.content]), [['group-a', '阶段结果 A'], ['group-a', '继续补充 A']]);
  f.network.complete(a, { answer: '内部执行记录，不对外发送' });
  await until(() => f.network.delegated.length === 2);
  const b = [...f.network.runs.values()][1]; f.network.complete(b, { answer: '群 B 的结果' }); await f.bridge.worker.running;
  assert.deepEqual(f.client.replies.map(r => r.content), ['阶段结果 A', '继续补充 A', '群 B 的结果']);
  assert.equal(f.client.replies.at(-1).chatid, 'group-b');
});

test('an unsent tool reply survives result delivery retry and suppresses the final echo after reopening', async t => {
  const f = await fixture(t, ['owner']);
  await f.bridge.receive(f.frame('work')); await until(() => [...f.bridge.worker.active.values()].some(x => x.runId));
  const run = [...f.network.runs.values()][0]; const send = f.client.sendMessage.bind(f.client); let offline = true;
  f.client.sendMessage = (...args) => { if (offline) throw new Error('offline fixture'); return send(...args); };
  await f.network.replyUser({ from: 'assistant', fromSessionKey: run.sessionKey, message: '已完成的部分结果' }); await f.bridge.outbox.running;
  f.network.complete(run, { answer: '内部最终记录' }); await f.bridge.worker.running;
  const item = [...f.bridge.inbox.items.values()][0];
  assert.equal(item.status, 'reply_pending'); assert.equal(f.client.replies.length, 0);
  offline = false; await f.bridge.worker.resume();
  assert.equal(item.status, 'completed'); assert.equal(f.network.delegated.length, 1);
  assert.deepEqual(f.client.replies.map(r => r.content), ['已完成的部分结果']);
  await f.bridge.close();
  const restored = new WecomBridge(f.network, f.client, f.bridge.config, { configFile: f.configFile,
    statusFile: resolve(f.root, 'status.json'), logFile: resolve(f.root, 'events.jsonl'), inboxDirectory: resolve(f.root, 'inbox') });
  await restored.ready; await restored.finish(run, item); await restored.close();
  assert.deepEqual(f.client.replies.map(r => r.content), ['已完成的部分结果']);
});

test('retrying a failed final attachment preserves its snapshot and does not repeat an acknowledged text', async t => {
  const f = await fixture(t, ['owner']);
  await f.bridge.receive(f.frame('make report')); await until(() => [...f.bridge.worker.active.values()].some(x => x.runId));
  const run = [...f.network.runs.values()][0]; const file = resolve(f.workspace, 'report.txt'); await writeFile(file, 'original');
  let offline = true; const uploads = []; const send = f.client.sendMediaMessage.bind(f.client);
  f.client.uploadMedia = async buffer => { uploads.push(buffer.toString()); return { media_id: 'media' }; };
  f.client.sendMediaMessage = (...args) => { if (offline) throw new Error('file offline fixture'); return send(...args); };
  f.network.complete(run, { answer: file, outputFiles: [{ path: file }] }); await f.bridge.worker.running;
  assert.equal([...f.bridge.inbox.items.values()][0].status, 'reply_pending');
  assert.equal(f.client.replies.length, 1);
  await writeFile(file, 'changed later'); offline = false; await f.bridge.worker.resume();
  assert.equal(f.client.replies.length, 1); assert.equal(f.client.mediaSent.length, 1);
  assert.equal(uploads.at(-1), 'original'); assert.equal(f.network.delegated.length, 1);
});

test('WeCom group controls and shared memory use the instance coordinator identity', async t => {
  const f = await fixture(t, ['owner'], 'research-lead', '阿岚');
  await f.bridge.receive(f.frame('状态'));
  await f.bridge.receive(f.frame('@阿岚 启用本群', 'owner', crypto.randomUUID(), 'group', 'research'));
  const confirmations=JSON.stringify(f.client.replies);
  assert.match(confirmations,/阿岚/); assert.doesNotMatch(confirmations,/示例机器人|ExampleBot/);
  await f.bridge.receive(f.frame('请协调研究任务'));
  await until(()=>f.network.delegated.length===1);
  const run=[...f.network.runs.values()][0];
  assert.equal(run.agentId,'research-lead');
  assert.match(f.bridge.context.prepare(run),/阿岚/);
  f.network.complete(run,{answer:'研究任务完成'}); await f.bridge.worker.running;
});

test('idle cancellation gives the actual cause to the original chat and retains the observed reason for its next turn', async t => {
  const f = await fixture(t, ['owner']);
  await f.bridge.receive(f.frame('Review this work'));
  await until(() => f.network.delegated.length === 1);
  const run = [...f.network.runs.values()][0];
  const cancellation = { source: 'idle_timeout', limitMs: 900000, requestedAt: new Date().toISOString(), lastProgressAt: new Date(Date.now()-900000).toISOString() };
  f.network.complete(run, { status: 'incomplete', stopReason: 'cancelled', cancellation });
  await f.bridge.worker.running;
  const delivered = f.bridge.outbox.forRun(run.runId);
  assert.equal(delivered.length, 1); assert.equal(delivered[0].chatid, 'owner');
  assert.equal(delivered[0].status, 'sent'); assert.match(delivered[0].content, /连续 15 分钟没有收到运行时进展/);
  const next = { id: 'future', chatid: 'owner', agentId: 'assistant', body: { chattype: 'single' } };
  const file = await f.bridge.writeConversationHistory(next);
  assert.deepEqual((await readJson(file)).entries[0].cancellation, cancellation);
});
