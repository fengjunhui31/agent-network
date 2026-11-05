import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, INSTANCE_ROOT, readJson, writeJson, redact } from '../../../src/paths.mjs';
import { AgentNetwork } from '../../../src/network.mjs';
import { startServer } from '../../../src/server.mjs';
import { WecomBridge } from '../src/wecom.mjs';

const tag = `concurrency-${Date.now()}`;
const report = { startedAt:new Date().toISOString(), mode:'real CLI and model; recording WeCom transport', cases:[], passed:true };
async function until(check, label, timeout=180000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {if(await check())return;await delay(200);}
  throw new Error(`Timed out: ${label}`);
}
for (const runtime of ['claude','dsh']) {
  const root=resolve(INSTANCE_ROOT,'.local/verification',tag,runtime);
  const config=await readJson(resolve(ROOT, 'network.example.json'));
  config.agents={assistant:{template:'coordinator',runtime,model:'deepseek-v4.1-flash'}};
  await writeJson(resolve(root,'network.json'),config);
  let service,bridge; const messages=[],injections=[];
  const entry={runtime,model:'deepseek-v4.1-flash',passed:false,liveWecomTransport:false};
  const routes=[{label:'A',type:'group',chatid:'qa-group-a'}, {label:'B',type:'group',chatid:'qa-group-b'}, {label:'DM',type:'single',chatid:'qa-owner'}];
  const frame=(route,content)=>({headers:{req_id:crypto.randomUUID()},body:{msgid:crypto.randomUUID(),from:{userid:'qa-owner'},
    chattype:route.type,chatid:route.type==='group'?route.chatid:undefined,msgtype:'text',text:{content}}});
  async function open() {
    service=await startServer({network:await AgentNetwork.create({root}),saveEndpoint:false});
    service.network.on('injected',event=>injections.push(event));
    class RecordingClient extends EventEmitter {
      connect(){this.emit('authenticated');} disconnect(){}
      async replyStream(){throw new Error('Unexpected receipt');}
      async sendMessage(chatid,body){messages.push({chatid,content:body.markdown.content,at:new Date().toISOString(),active:service.network.busy.size});return {errcode:0};}
    }
    bridge=new WecomBridge(service.network,new RecordingClient(),{botId:'qa',secret:'recording-only',agentId:'assistant',allowedUserIds:['qa-owner'],enabledGroupIds:['qa-group-a','qa-group-b']},
      {configFile:resolve(root,'wecom.json'),statusFile:resolve(root,'status.json'),logFile:resolve(root,'events.jsonl'),inboxDirectory:resolve(root,'inbox')}).start();
    await bridge.ready;
  }
  async function close(){await bridge?.close();await service?.close();await bridge?.worker.running;await bridge?.statusQueue;}
  try {
    await open();
    const workspace=service.network.catalog.get('assistant').workspace;
    const release=resolve(workspace,'release-concurrency.txt');
    for(const route of routes){
      route.nonce=crypto.randomUUID();route.ready=resolve(workspace,`ready-${route.label}.txt`);
      await bridge.receive(frame(route,`本轮是并发验证，只做下面步骤，不委派，不查看其他任务文件。你这条会话的标签是 ${route.label}，标记是 ${route.nonce}。先调用 local-network 的 reply_user，内容严格为 BEGIN:${route.label}:${route.nonce}。然后用原生 shell 执行：printf ready > '${route.ready}'; for i in $(seq 1 180); do test -f '${release}' && break; sleep 1; done; test -f '${release}'。命令返回后检查本会话补充消息：若收到 OVERRIDE=xxx，则调用 reply_user 发送 FINAL:${route.label}:xxx；否则发送 FINAL:${route.label}:${route.nonce}。最终内部输出仅写 INTERNAL，不列文件路径，不发送其他消息。`));
    }
    await until(async()=> (await Promise.all(routes.map(route=>access(route.ready).then(()=>true,()=>false)))).every(Boolean),`${runtime} three native tools running`);
    assert.equal(service.network.busy.size,3);
    assert.equal(bridge.worker.active.size,3);
    assert.equal(service.network.catalog.list().agents.length,1);
    assert.equal(new Set([...service.network.runtimes.values()].map(x=>x.agent.workspace)).size,1);
    console.log(JSON.stringify({runtime,phase:'three conversations simultaneously executing native tools'}));
    for(const route of [routes[0],routes[2]]) {
      route.override=crypto.randomUUID();await bridge.receive(frame(route,`仅补充当前任务：OVERRIDE=${route.override}。其他步骤不变，不另起任务。`));
    }
    await until(()=>[...bridge.inbox.items.values()].filter(x=>x.status==='attached').length===2,'supplements attached');
    await writeFile(release,'continue');
    await until(()=>[...bridge.inbox.items.values()].every(x=>['completed','failed'].includes(x.status)),`${runtime} all tasks finish`);
    for(const item of bridge.inbox.items.values())assert.equal(item.status,'completed',item.error);
    const runs=[...service.network.runs.values()];assert.equal(runs.length,3);
    assert.equal(new Set(runs.map(x=>x.sessionId)).size,3);
    const sessions=Object.fromEntries(runs.map(x=>[x.sessionKey,x.sessionId]));
    for(const route of routes){
      assert.deepEqual(messages.filter(x=>x.chatid===route.chatid).map(x=>x.content),[`BEGIN:${route.label}:${route.nonce}`,`FINAL:${route.label}:${route.override??route.nonce}`]);
      const injected=injections.filter(x=>x.sessionKey===`wecom:${route.type}:${route.chatid}`).map(x=>({...x,messages:x.messages.filter(m=>!m.contextOnly)})).filter(x=>x.messages.length);
      if(route.override) assert.ok(injected.some(x=>x.event==='PostToolUse'&&x.messages.some(m=>m.message.includes(route.override))));
      else assert.equal(injected.length,0);
      for(const other of routes.filter(x=>x!==route)) assert.ok(!JSON.stringify(injected).includes(other.override??other.nonce));
    }
    assert.ok(messages.every(x=>x.active>0),'Tool replies must happen during execution');
    await close();
    await open();
    for(const route of routes) await bridge.receive(frame(route,`恢复验证：仅用 reply_user 发送 RESUMED:${route.label}。不要执行其他操作，最终内部回答写 INTERNAL。`));
    await until(()=>[...bridge.inbox.items.values()].every(x=>['completed','failed'].includes(x.status)),`${runtime} resume conversations`);
    for(const item of bridge.inbox.items.values())assert.equal(item.status,'completed',item.error);
    const resumed=[...service.network.runs.values()];assert.equal(resumed.length,3);
    for(const run of resumed)assert.equal(run.sessionId,sessions[run.sessionKey]);
    Object.assign(entry,{passed:true,sharedIdentity:true,sharedWorkspace:workspace,threeSimultaneousExecutions:true,isolatedSupplements:true,
      sameChatSupplementsCreatedNoExtraRun:true,sourceRepliesCorrect:true,allSessionsResumed:true,sessions,messages,injections});
    console.log(JSON.stringify({runtime,passed:true,phase:'parallel tasks, scoped hooks/replies and restart restore'}));
  } catch(error){entry.error=redact(error.message);entry.messages=messages;entry.injections=injections;
    entry.runs=service?[...service.network.runs.values()].map(x=>service.network.snapshot(x)):[];report.passed=false;console.log(JSON.stringify({runtime,passed:false,error:entry.error}));}
  finally{await close();report.cases.push(entry);await writeJson(resolve(INSTANCE_ROOT,'verification',`${tag}.json`),report);}
}
report.endedAt=new Date().toISOString();await writeJson(resolve(INSTANCE_ROOT,'verification',`${tag}.json`),report);
console.log(JSON.stringify({passed:report.passed,report:`verification/${tag}.json`}));
if(!report.passed)process.exitCode=1;
