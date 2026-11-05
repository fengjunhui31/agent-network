import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, INSTANCE_ROOT, readJson, writeJson, redact } from '../../../src/paths.mjs';
import { AgentNetwork } from '../../../src/network.mjs';
import { startServer } from '../../../src/server.mjs';
import { WecomBridge } from '../src/wecom.mjs';

const tag=`shared-memory-${Date.now()}`;
const report={startedAt:new Date().toISOString(),mode:'real CLI and model; recording WeCom transport',cases:[],passed:true};
async function until(check,label,timeout=180000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {if(await check())return;await delay(200);}
  throw new Error(`Timed out: ${label}`);
}
const exists=path=>access(path).then(()=>true,()=>false);
const replyValue=(message,prefix)=>message.startsWith(prefix)?message.slice(prefix.length).trim():undefined;
await Promise.all(['claude','dsh'].map(async runtime=>{
  const root=resolve(INSTANCE_ROOT,'.local/verification',tag,runtime);
  const config=await readJson(resolve(ROOT, 'network.example.json'));
  config.agents={assistant:{template:'coordinator',runtime,model:'deepseek-v4.1-flash'}};
  await writeJson(resolve(root,'network.json'),config);
  const entry={runtime,model:'deepseek-v4.1-flash',passed:false,liveWecomTransport:false};
  let service,bridge,parentId;
  const messages=[],injections=[];
  const routes={A:{type:'group',chatid:'qa-group-a'},B:{type:'group',chatid:'qa-group-b'},DM:{type:'single',chatid:'qa-owner'}};
  const frame=(route,content)=>({headers:{req_id:crypto.randomUUID()},body:{msgid:crypto.randomUUID(),from:{userid:'qa-owner'},
    chattype:route.type,chatid:route.type==='group'?route.chatid:undefined,msgtype:'text',text:{content}}});
  const log=phase=>console.log(JSON.stringify({runtime,phase}));
  async function open() {
    service=await startServer({network:await AgentNetwork.create({root}),saveEndpoint:false});
    service.network.on('injected',event=>injections.push(event));
    class RecordingClient extends EventEmitter {
      connect(){this.emit('authenticated');} disconnect(){}
      async replyStream(){throw new Error('Unexpected receipt');}
      async sendMessage(chatid,body){messages.push({chatid,content:body.markdown.content,at:new Date().toISOString(),parentStatus:service.network.runs.get(parentId)?.status});return {errcode:0};}
    }
    bridge=new WecomBridge(service.network,new RecordingClient(),{botId:'qa',secret:'recording-only',agentId:'assistant',allowedUserIds:['qa-owner'],enabledGroupIds:['qa-group-a','qa-group-b']},
      {configFile:resolve(root,'wecom.json'),statusFile:resolve(root,'status.json'),logFile:resolve(root,'events.jsonl'),inboxDirectory:resolve(root,'inbox')}).start();
    await bridge.ready;
  }
  async function close(){await bridge?.close();await service?.close();await bridge?.worker.running;await bridge?.statusQueue;}
  async function finishInbox(label) {
    await until(()=>[...bridge.inbox.items.values()].every(x=>['completed','failed'].includes(x.status)),label);
    for(const item of bridge.inbox.items.values())assert.equal(item.status,'completed',item.error);
  }
  try {
    await open();
    const workspace=service.network.catalog.get('assistant').workspace;
    const nickname=`Project-${crypto.randomUUID()}`;
    await bridge.receive(frame(routes.A,`记住，我的项目代号是 ${nickname}。现在仅调用 reply_user 回复 SAVED，最终内部文字写 INTERNAL。不要写文件或委派。`));
    await finishInbox(`${runtime} remember group A`);
    const first=[...service.network.runs.values()][0];
    await bridge.receive(frame(routes.B,'接着我在另一个群说的项目聊：它的项目代号是什么？仅调用 reply_user 回复 RECALL_GROUP: 加上完整代号，最终内部文字写 INTERNAL。不要问我代号，不要委派。'));
    await finishInbox(`${runtime} recall group B`);
    assert.ok(messages.some(x=>x.chatid===routes.B.chatid&&replyValue(x.content,'RECALL_GROUP:')===nickname));
    const recordsBefore=bridge.context.memory.entries.size;
    await close();await open();
    assert.equal(bridge.context.memory.entries.size,recordsBefore,'restart must not duplicate records');
    await bridge.receive(frame(routes.DM,'接着之前在群里说的项目：告诉我完整项目代号。仅调用 reply_user 回复 RECALL_DM: 加上完整代号，最终内部文字写 INTERNAL。不要问我，不要委派。'));
    await finishInbox(`${runtime} recall after restart in new DM`);
    assert.ok(messages.some(x=>x.chatid===routes.DM.chatid&&replyValue(x.content,'RECALL_DM:')===nickname));
    const dm=[...service.network.runs.values()][0];assert.notEqual(dm.sessionId,first.sessionId);
    log('shared recall across groups and new DM after restart');
    const parentReady=resolve(workspace,'parent-ready.txt'),childReady=resolve(workspace,'child-ready.txt');
    const parentRelease=resolve(workspace,'release-parent.txt'),childRelease=resolve(workspace,'release-child.txt');
    const waitCommand=(ready,release)=>`printf ready > '${ready}'; for i in $(seq 1 180); do test -f '${release}' && break; sleep 1; done; test -f '${release}'`;
    const childTask=`你是同一个 ExampleBot 的并行执行。只做这些步骤，不再委派：先调用 reply_user 回复 CHILD_BEGIN。然后用原生 shell 前台执行（超时至少 180 秒，不后台运行）：${waitCommand(childReady,childRelease)}。工具结束后检查 hook 的同一来源新消息，其中 CHILD_OVERRIDE=xxx 是本任务需要用的新代号。仅调用 reply_user 回复 CHILD_DONE:xxx；如果没有补充则回复 CHILD_DONE:MISSING。最终内部文字仅写 INTERNAL，不列文件路径、不报告其他任务。`;
    await bridge.receive(frame(routes.A,`验证同群并行。先调用 local-network 的 delegate，target 为 assistant，parallel 为 true，message 使用以下完整子任务：\n${childTask}\n子任务说明结束。\n你自己继续主任务：用原生 shell 前台执行（超时至少 180 秒，不后台运行）：${waitCommand(parentReady,parentRelease)}。命令返回后仅调用 reply_user 回复 MAIN_DONE，然后结束，最终内部文字写 INTERNAL。不要等子任务，不查询子任务结果，不重复子任务工作。后续 CHILD_OVERRIDE 消息由子任务自行从 hook 读取，你不用回复它。`));
    await until(async()=>await exists(parentReady)&&await exists(childReady),`${runtime} parent and child tools running`);
    const parent=[...service.network.runs.values()].find(x=>x.status==='running'&&!x.parallel);
    const child=[...service.network.runs.values()].find(x=>x.status==='running'&&x.parallel);
    assert.ok(parent&&child);parentId=parent.runId;
    assert.equal(child.agentId,parent.agentId);assert.equal(child.workspace,parent.workspace);
    assert.equal(child.originMessageId,parent.originMessageId);assert.equal(child.parentRunId,parent.runId);
    assert.notEqual(child.sessionKey,parent.sessionKey);
    assert.equal(service.network.catalog.list().agents.length,1);
    assert.equal(service.network.busy.size,2);
    log('same identity and workspace, two native tools active in one group');
    const override=crypto.randomUUID();
    await bridge.receive(frame(routes.A,`补充并行子任务：CHILD_OVERRIDE=${override}。主任务按原样结束；子任务用这个新代号回复。`));
    await until(()=>[...bridge.inbox.items.values()].some(x=>x.status==='attached'),'supplement attached');
    await writeFile(parentRelease,'continue');
    await until(()=>parent.status!=='running',`${runtime} parent ended before child`);
    assert.equal(parent.status,'completed',parent.error);assert.equal(child.status,'running');
    await writeFile(childRelease,'continue');
    await until(()=>child.status!=='running',`${runtime} child ended`);
    assert.equal(child.status,'completed',child.error);
    await finishInbox(`${runtime} inbox finalized`);await bridge.outbox.running;
    assert.ok(messages.some(x=>x.chatid===routes.A.chatid&&replyValue(x.content,'CHILD_DONE:')===override&&x.parentStatus==='completed'));
    assert.ok(injections.some(x=>x.runId===child.runId&&x.messages.some(m=>m.contextOnly&&m.message.includes(override))));
    assert.notEqual(child.sessionId,parent.sessionId);
    assert.ok(![...service.network.runtimes.values()].some(runtime=>runtime.agent.sessionKey===child.sessionKey),'completed parallel process is released');
    assert.equal([...service.network.runs.values()].length,3,'DM plus two explicit parallel executions; no network intent router');
    Object.assign(entry,{passed:true,crossGroupRecall:true,newPrivateSessionRecallAfterRestart:true,
      sameGroupParallel:true,sharedIdentity:true,sharedWorkspace:workspace,childReceivedSupplementViaHook:true,
      childRepliedToOriginalGroupAfterParentEnded:true,memoryRecords:bridge.context.memory.entries.size,
      parentRunId:parent.runId,childRunId:child.runId,sessions:[first.sessionId,dm.sessionId,parent.sessionId,child.sessionId]});
    log('passed shared memory and same-group parallel hook/reply verification');
  } catch(error) {entry.error=redact(error.message);report.passed=false;log(`FAILED: ${entry.error}`);}
  finally {
    entry.messages=messages;entry.injections=injections;
    entry.runs=service?[...service.network.runs.values()].map(x=>service.network.snapshot(x)):[];
    await close();report.cases.push(entry);
    await writeJson(resolve(INSTANCE_ROOT,'verification',`${tag}-${runtime}.json`),entry);
  }
}));
report.endedAt=new Date().toISOString();await writeJson(resolve(INSTANCE_ROOT,'verification',`${tag}.json`),report);
console.log(JSON.stringify({passed:report.passed,report:`verification/${tag}.json`}));
if(!report.passed)process.exitCode=1;
