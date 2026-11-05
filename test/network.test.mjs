import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { executionKey } from '../src/sessions.mjs';
import { Catalog } from '../src/catalog.mjs';
import { AgentNetwork } from '../src/network.mjs';
import { AcpRuntime } from '../src/runtime-acp.mjs';
import { startServer } from '../src/server.mjs';
import { INSTANCE_ROOT, ROOT, writeJson, readJson } from '../src/paths.mjs';
import { teamControl } from '../src/team-control.mjs';

// These are deterministic infrastructure tests with a fake runtime, not LLM evidence.
import { fixture } from './network-fixture.mjs';

test('separate member workspaces; one active execution per member; different members run concurrently', async t => {
  const { network, controls } = await fixture(t);
  const ready = once(network, 'event');
  const first = await network.delegate({ target: 'a', message: 'A' }); await ready;
  await assert.rejects(network.delegate({ target: 'a', message: 'duplicate' }), /busy/);
  const secondReady = once(network, 'event');
  const second = await network.delegate({ target: 'b', message: 'B' }); await secondReady;
  assert.notEqual(first.workspace, second.workspace);
  assert.equal(network.busy.size, 2);
  controls.get('a').finish({ answer: 'A complete', stopReason: 'end_turn' });
  controls.get('b').finish({ answer: 'B complete', stopReason: 'end_turn' });
  assert.equal((await network.getResult(first.runId, 1000)).status, 'completed');
});

test('native hook command injects a mid-run message once, including shared file references', async t => {
  const { network, service, controls } = await fixture(t);
  const ready = once(network, 'event');
  const run = await network.delegate({ target: 'b', message: 'work' }); await ready;
  const file = resolve(network.catalog.get('a').workspace, 'source.txt'); await writeFile(file, 'shared');
  await network.send({ from: 'a', to: 'b', message: 'BOUNDARY-MESSAGE', files: [file] });
  const child = spawn(process.execPath, [resolve(ROOT, 'src/hook.mjs')], {
    env: { ...process.env, LAN_URL: service.endpoint.url, LAN_TOKEN: service.endpoint.token, LAN_AGENT_ID: 'b' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', data => { output += data; });
  child.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse' }));
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
  assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /BOUNDARY-MESSAGE/);
  assert.deepEqual(network.receive('b', 'PostToolUse').messages, []);
  assert.ok(controls.get('b').readableFiles.has(file));
  controls.get('b').finish({ answer: 'done', stopReason: 'end_turn' }); await network.getResult(run.runId, 1000);
});

test('unknown recipients fail immediately and results survive a new network instance', async t => {
  const { network, controls, root } = await fixture(t);
  await assert.rejects(network.send({ to: 'missing', message: 'hello' }), /Unknown agent/);
  const ready = once(network, 'event'); const run = await network.delegate({ target: 'a', message: 'work' }); await ready;
  await writeFile(resolve(run.workspace, 'report.txt'), 'evidence');
  controls.get('a').finish({ answer: 'report written ' + resolve(run.workspace, 'report.txt'), stopReason: 'end_turn' });
  const result = await network.getResult(run.runId, 1000);
  assert.equal(result.outputFiles.length, 1);
  const fresh = new AgentNetwork(await Catalog.load(root), { root });
  assert.equal((await fresh.getResult(run.runId)).answer, 'report written ' + resolve(run.workspace, 'report.txt'));
});

test('template instances have independent directories and retained role capabilities', async t => {
  const { network } = await fixture(t);
  const first = await network.catalog.create('worker'); const second = await network.catalog.create('worker');
  assert.notEqual(first.id, second.id); assert.notEqual(first.workspace, second.workspace);
  assert.deepEqual(first.capabilities, ['test']); assert.equal(first.persistent, false);
  await assert.rejects(network.catalog.create('worker', '../escape'), /Invalid agent id/);
});

test('local API rejects requests without the per-process capability', async t => {
  const { service } = await fixture(t);
  const res = await fetch(`${service.endpoint.url}/catalog`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
});

test('all three MCP tools operate through a real stdio client and local service', async t => {
  const { network, service, controls } = await fixture(t);
  const client = new Client({ name: 'network-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(ROOT, 'src/mcp.mjs')],
    env: { ...process.env, LAN_URL: service.endpoint.url, LAN_TOKEN: service.endpoint.token, LAN_AGENT_ID: 'test-caller', LAN_CAN_REPLY: '0' } }));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(x => x.name).sort(), ['delegate', 'get_result', 'send_message']);
  const ready = once(network, 'event');
  const delegated = await client.callTool({ name: 'delegate', arguments: { target: 'b', message: 'MCP work' } });
  const run = JSON.parse(delegated.content[0].text); await ready;
  const sent = await client.callTool({ name: 'send_message', arguments: { to: 'b', message: 'MCP progress' } });
  assert.equal(JSON.parse(sent.content[0].text).accepted, true);
  assert.equal(network.receive('b', 'PostToolUse').messages[0].message, 'MCP progress');
  controls.get('b').finish({ answer: 'MCP result', stopReason: 'end_turn' });
  const result = await client.callTool({ name: 'get_result', arguments: { runId: run.runId, waitMs: 1000 } });
  assert.equal(JSON.parse(result.content[0].text).answer, 'MCP result');
  assert.equal(JSON.parse(result.content[0].text).events, undefined);
});

test('the coordinator reply tool uses the real MCP transport and only accepts an active coordinator', async t => {
  const { network, service, controls } = await fixture(t);
  await network.catalog.update('a', { manager: true });
  const received = [];
  network.userReply = async request => { received.push(request); return { queued: true, messageId: 'queued-reply' }; };
  const client = new Client({ name: 'reply-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(ROOT, 'src/mcp.mjs')],
    env: { ...process.env, LAN_URL: service.endpoint.url, LAN_TOKEN: service.endpoint.token, LAN_AGENT_ID: 'a', LAN_CAN_REPLY: '1' } }));
  t.after(() => client.close());
  assert.ok((await client.listTools()).tools.some(x => x.name === 'reply_user'));
  assert.equal((await client.callTool({ name: 'reply_user', arguments: { message: 'no task' } })).isError, true);
  const ready = once(network, 'event'); const run = await network.delegate({ target: 'a', message: 'work' }); await ready;
  const reply = await client.callTool({ name: 'reply_user', arguments: { message: '阶段结果' } });
  assert.equal(JSON.parse(reply.content[0].text).queued, true);
  assert.deepEqual(received, [{ from: 'a', runId: run.runId, message: '阶段结果' }]);
  assert.equal(network.busy.get('a'), run.runId);
  await assert.rejects(network.replyUser({ from: 'b', message: 'cannot speak for the coordinator' }), /只有主控/);
  controls.get('a').finish({ answer: 'done', stopReason: 'end_turn' }); await network.getResult(run.runId, 1000);
  assert.equal((await client.callTool({ name: 'reply_user', arguments: { message: 'too late' } })).isError, true);
});

test('fixed members use defaults, template and member overrides; restart refreshes configuration', async t => {
  const { root } = await fixture(t);
  const config = await readJson(resolve(root, 'network.json'));
  config.defaults = { instructions: 'global', modelEnv: 'GLM_MODEL' };
  config.agents.a.instructions = 'member-specific';
  await writeJson(resolve(root, 'network.json'), config);
  const reloaded = await Catalog.load(root);
  assert.equal(reloaded.get('a').instructions, 'member-specific');
  assert.equal(reloaded.get('a').modelEnv, 'GLM_MODEL');
  assert.equal(reloaded.get('b').instructions, 'test');
});

test('a second service cannot concurrently own the same persisted member sessions', async t => {
  const { root } = await fixture(t);
  const first = await startServer({ network: new AgentNetwork(await Catalog.load(root), { root }) });
  t.after(() => first.close());
  await assert.rejects(startServer({ network: new AgentNetwork(await Catalog.load(root), { root }) }), /already owns/);
});

test('concurrent template creation retains every member after reopening the directory', async t => {
  const { network, root } = await fixture(t);
  const created = await Promise.all(Array.from({ length: 12 }, () => network.catalog.create('worker')));
  const fresh = await Catalog.load(root);
  for (const member of created) assert.equal(fresh.get(member.id).workspace, member.workspace);
});

test('conversation members inherit scope and cannot delegate, message or query results across groups', async t => {
  const { network, root, service, controls } = await fixture(t);
  const a = await network.catalog.create('worker', 'group-a', true, { scope: 'group-a' });
  const b = await network.catalog.create('worker', 'group-b', true, { scope: 'group-b' });
  for (const member of [a, b]) {
    const ready = once(network, 'event'); await network.delegate({ target: member.id, message: 'coordinate' }); await ready;
  }
  const ready = once(network, 'event');
  const child = await network.delegate({ target: 'template:worker', message: 'group A work', from: a.id }); await ready;
  assert.ok(controls.get(child.agentId).lastMessage.includes(`本轮委派者 ID：${a.id}`));
  assert.equal(network.catalog.get(child.agentId).scope, a.scope);
  await assert.rejects(network.delegate({ target: 'b', message: 'cross to private', from: a.id }), /different conversation/);
  await assert.rejects(network.send({ to: b.id, message: 'cross group', from: child.agentId }), /different conversation/);
  await assert.rejects(network.getResult(child.runId, 0, b.id), /different conversation/);
  assert.equal((await network.getResult(child.runId, 0, a.id)).status, 'running');
  const denied = await fetch(`${service.endpoint.url}/result`, { method: 'POST',
    headers: { authorization: `Bearer ${service.endpoint.token}` }, body: JSON.stringify({ runId: child.runId, from: b.id }) });
  assert.equal(denied.status, 400);
  await network.catalog.prepare(a);
  const memberStatus=await readJson(resolve(a.workspace,'TEAM-CURRENT.json'));
  assert.ok(memberStatus.employees.some(member=>member.id===child.agentId));
  assert.ok(!memberStatus.employees.some(member=>member.id==='group-b'));
  const restored = await Catalog.load(root);
  assert.equal(restored.get(child.agentId).scope, a.scope);
});

test('a coordinator creates and updates employees with independent model and runtime settings', async t => {
  const { network, root } = await fixture(t);
  const config = await readJson(resolve(root, 'network.json')); config.models = { 'model-a': {}, 'model-b': {} };
  await writeJson(resolve(root, 'network.json'), config); await network.catalog.refresh();
  const manager = await network.catalog.create('worker', 'manager', true, { manager: true, scope: 'team' });
  const worker = await teamControl(network, { action: 'create', template: 'worker', id: 'specialist', from: manager.id, patch: { model: 'model-a', runtime: 'claude', name: '同事' } });
  assert.equal(worker.scope, 'team'); assert.equal(worker.model, 'model-a');
  await teamControl(network, { action: 'update', id: worker.id, from: manager.id, patch: { model: 'model-b', runtime: 'dsh' } });
  const restored = await Catalog.load(root); await restored.refresh();
  assert.equal(restored.get(worker.id).model, 'model-b'); assert.equal(restored.get(worker.id).runtime, 'dsh');
  await assert.rejects(teamControl(network, { action: 'status', from: 'a' }), /coordinator/);
  await assert.rejects(teamControl(network, { action: 'update', id: 'a', from: manager.id, patch: { name: 'cross-scope' } }), /different conversation/);
});

test('external configuration changes refresh the coordinator manual and capability revision', async t => {
  const { network, root } = await fixture(t);
  const manager = await network.catalog.create('worker', 'manager', true, { manager: true });
  await network.catalog.prepare(manager);
  const before = await readJson(resolve(manager.workspace, 'TEAM-CURRENT.json'));
  const config = await readJson(resolve(root, 'network.json')); config.templates.worker.capabilities.push('new skill');
  config.agents.external = { template: 'worker' };
  await writeJson(resolve(root, 'network.json'), config); await network.catalog.refresh();
  await network.catalog.prepare(network.catalog.get(manager.id));
  const after = await readJson(resolve(manager.workspace, 'TEAM-CURRENT.json'));
  assert.notEqual(after.revision, before.revision);
  assert.ok(after.employees.some(x => x.id === 'external'));
  assert.ok((await readFile(resolve(manager.workspace, 'TEAM.md'), 'utf8')).includes('共享网络规范'));
});

test('coordinator and worker receive the same versioned guide and can read it without gaining application write access',async t=>{
  const {network}=await fixture(t);const manager=await network.catalog.update('a',{manager:true});const employee=network.catalog.get('b');
  const guides=[];
  for(const agent of [manager,employee]){
    const instructions=await network.catalog.prepare(agent);const status=await readJson(resolve(agent.workspace,'TEAM-CURRENT.json'));
    assert.ok(instructions.includes(status.networkSkill.entrypoint));guides.push(status.networkSkill);
    const runtime=new AcpRuntime(agent,{},()=>{});
    for(const file of status.networkSkill.files){runtime.checkPath(file);assert.throws(()=>runtime.checkPath(file,true),/outside/i);}
    assert.throws(()=>runtime.checkPath(resolve(status.networkRoot,'network.json')),/outside/i);
  }
  assert.deepEqual(guides[0],guides[1]);
});

test('one identity has independent native state per chat; real MCP and hook transports target the captured chat', async t => {
  const { network, service, controls } = await fixture(t);
  await network.catalog.update('a', { manager: true });
  const start = async sessionKey => {
    const ready = once(network, 'event');
    const request = await network.delegate({ target: 'a', sessionKey, message: 'parallel task' }); await ready;
    return network.runs.get(request.runId);
  };
  const a = await start('chat-a'); const b = await start('chat-b');
  assert.equal(a.workspace, b.workspace);
  assert.notEqual(controls.get(executionKey('a','chat-a')).agent.configDirectory, controls.get(executionKey('a','chat-b')).agent.configDirectory);
  await assert.rejects(network.delegate({target:'a', sessionKey:'chat-a', message:'same chat'}), /busy/);
  const replies = []; network.userReply = async request => { replies.push(request); return {queued:true}; };
  const clients = [];
  for (const sessionKey of ['chat-a','chat-b']) {
    const client = new Client({name:'parallel-chat-test',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve(ROOT,'src/mcp.mjs')],env:{...process.env,
      LAN_URL:service.endpoint.url,LAN_TOKEN:service.endpoint.token,LAN_AGENT_ID:'a',LAN_CAN_REPLY:'1',LAN_SESSION_KEY:sessionKey}}));
    clients.push(client); t.after(()=>client.close());
  }
  await Promise.all(clients.map((client,i)=>client.callTool({name:'reply_user',arguments:{message:`reply-${i}`}})));
  assert.deepEqual(replies.map(x=>[x.runId,x.message]).sort(), [[a.runId,'reply-0'],[b.runId,'reply-1']].sort());
  await network.send({to:'a',expectedRunId:b.runId,message:'ONLY-B'});
  const child=spawn(process.execPath,[resolve(ROOT,'src/hook.mjs')],{env:{...process.env,LAN_URL:service.endpoint.url,
    LAN_TOKEN:service.endpoint.token,LAN_AGENT_ID:'a',LAN_SESSION_KEY:'chat-a'},stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stdin.end('{"hook_event_name":"PostToolUse"}');
  await once(child,'exit');assert.equal(output,'');assert.equal(network.receive('a','PostToolUse','chat-b').messages[0].message,'ONLY-B');
  await network.cancel('a','chat-b'); await b.settled;
  assert.equal(network.activeRun('a','chat-a').runId,a.runId);
  assert.equal((await clients[1].callTool({name:'reply_user',arguments:{message:'too late'}})).isError,true);
});

test('parallel specialist results and progress return only to their original parent run, including after a successor starts', async t => {
  const { network, controls } = await fixture(t);
  const start=async(target,sessionKey,from)=>{
    const ready=once(network,'event');const r=await network.delegate({target,sessionKey,from,fromSessionKey:from?sessionKey:undefined,message:'task'});
    await ready;return network.runs.get(r.runId);
  };
  const a=await start('a','chat-a');const b=await start('a','chat-b');
  const childA=await start('b','chat-a','a');const childB=await start('b','chat-b','a');
  assert.equal(childA.parentRunId,a.runId);assert.equal(childB.parentRunId,b.runId);
  await network.send({from:'b',fromSessionKey:'chat-a',to:'a',message:'A progress'});
  assert.deepEqual(network.receive('a','PostToolUse','chat-b').messages,[]);
  assert.equal(network.receive('a','PostToolUse','chat-a').messages[0].message,'A progress');
  controls.get(executionKey('a','chat-a')).finish({answer:'parent complete',stopReason:'end_turn'});await a.settled;
  const next=await start('a','chat-a');
  await assert.rejects(network.send({from:'b',fromSessionKey:'chat-a',to:'a',message:'late A progress'}),/Active execution changed/);
  controls.get(executionKey('b','chat-a')).finish({answer:'late A result',stopReason:'end_turn'});await childA.settled;
  assert.deepEqual(network.receive('a','PostToolUse','chat-a').messages,[]);
  controls.get(executionKey('b','chat-b')).finish({answer:'B result',stopReason:'end_turn'});await childB.settled;
  assert.match(network.receive('a','PostToolUse','chat-b').messages[0].message,/B result/);
  assert.equal(network.activeRun('a','chat-a').runId,next.runId);
});


test('MCP send_message wakes an idle employee while preserving the sender execution and original source',async t=>{
  const {network,service,controls}=await fixture(t);
  const ready=once(network,'event');const first=await network.delegate({target:'a',sessionKey:'group-a',originMessageId:'source-a',message:'coordinate'});await ready;
  const parent=network.runs.get(first.runId);
  const caller=new Client({name:'idle-employee-wake',version:'1'});t.after(()=>caller.close());
  await caller.connect(new StdioClientTransport({command:process.execPath,args:[resolve(ROOT,'src/mcp.mjs')],env:{...process.env,
    LAN_URL:service.endpoint.url,LAN_TOKEN:service.endpoint.token,LAN_AGENT_ID:'a',LAN_SESSION_KEY:parent.sessionKey}}));
  const childReady=once(network,'event');const response=await caller.callTool({name:'send_message',arguments:{to:'b',message:'wake and work'}});await childReady;
  const child=network.runs.get(JSON.parse(response.content[0].text).wakeRunId);
  assert.equal(child.parentRunId,parent.runId);assert.equal(child.from,'a');assert.equal(child.originMessageId,'source-a');
  await network.send({from:'b',fromSessionKey:child.sessionKey,to:'a',message:'awake progress'});
  assert.equal(network.receive('a','PostToolUse',parent.sessionKey).messages[0].message,'awake progress');
  controls.get(executionKey('b',child.sessionKey)).finish({answer:'awake complete',stopReason:'end_turn'});await child.settled;
  assert.match(network.receive('a','PostToolUse',parent.sessionKey).messages[0].message,/awake complete/);
});

test('only the independent controller credential can hold and release admission', async t => {
  const { network, root } = await fixture(t);
  const service = await startServer({ network });
  t.after(() => service.close());
  const ep = service.endpoint;
  const maintenance = token => fetch(ep.url + '/maintenance', {
    method: 'POST', headers: {authorization: 'Bearer ' + token}, body: JSON.stringify({action:'drain'})});
  assert.equal((await maintenance(ep.token)).status, 401);
  const ctl = await readJson(resolve(root, '.local/release-control.json'));
  assert.notEqual(ctl.token, ep.token);
  const state = await (await maintenance(ctl.token)).json();
  assert.equal(state.phase, 'draining');
  assert.equal(state.readyToStop, true);
  assert.equal(network.gate.command('resume', network).phase, 'open');
});
