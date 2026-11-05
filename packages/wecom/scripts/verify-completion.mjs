import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, INSTANCE_ROOT, readJson, writeJson, redact } from '../../../src/paths.mjs';
import { AgentNetwork } from '../../../src/network.mjs';
import { startServer } from '../../../src/server.mjs';
import { WecomBridge } from '../src/wecom.mjs';

const tag=`completion-${Date.now()}`;
const report={startedAt:new Date().toISOString(),mode:'real CLI and model; recording WeCom transport',passed:true,cases:[]};
async function until(check,label,timeout=240000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await delay(200);}throw new Error(`Timed out: ${label}`);}
const exists=path=>access(path).then(()=>true,()=>false);
const contentValue=(text,prefix)=>text.startsWith(prefix)?text.slice(prefix.length).trim():undefined;
await Promise.all(['claude','dsh'].map(async runtime=>{
  const workerRuntime=runtime==='claude'?'dsh':'claude';
  const root=resolve(INSTANCE_ROOT,'.local/verification',tag,runtime);
  const config=await readJson(resolve(ROOT, 'network.example.json'));
  config.agents={assistant:{template:'coordinator',runtime,model:'deepseek-v4.1-flash'},worker:{template:'engineer',runtime:workerRuntime,model:'deepseek-v4.1-flash'}};
  await writeJson(resolve(root,'network.json'),config);
  const entry={runtime,workerRuntime,model:'deepseek-v4.1-flash',passed:false,liveWecomTransport:false};
  const messages=[],uploads=[],media=[],injections=[];let service,bridge;
  const log=phase=>console.log(JSON.stringify({runtime,phase}));
  const frame=(chatid,content)=>({headers:{req_id:crypto.randomUUID()},body:{msgid:crypto.randomUUID(),from:{userid:'qa-owner'},chattype:'group',chatid,msgtype:'text',text:{content}}});
  try {
    service=await startServer({network:await AgentNetwork.create({root}),saveEndpoint:false});
    service.network.on('injected',event=>injections.push(event));
    class RecordingClient extends EventEmitter {
      connect(){this.emit('authenticated');}disconnect(){}
      async replyStream(){throw new Error('Unexpected placeholder reply');}
      async sendMessage(chatid,body){messages.push({chatid,text:body.markdown.content,at:new Date().toISOString()});return {errcode:0};}
      async uploadMedia(buffer,{filename}){uploads.push({filename,text:buffer.toString()});return {media_id:filename};}
      async sendMediaMessage(chatid,type,id){media.push({chatid,type,id});return {errcode:0};}
    }
    bridge=new WecomBridge(service.network,new RecordingClient(),{agentId:'assistant',botId:'qa',secret:'recording-only',allowedUserIds:['qa-owner'],enabledGroupIds:['qa-a','qa-b']},
      {configFile:resolve(root,'wecom.json'),statusFile:resolve(root,'status.json'),logFile:resolve(root,'events.jsonl'),inboxDirectory:resolve(root,'inbox')}).start();
    await bridge.ready;
    const worker=service.network.catalog.get('worker'),coordinator=service.network.catalog.get('assistant');
    const ready=resolve(worker.workspace,'worker-ready.txt'),release=resolve(worker.workspace,'worker-release.txt'),file=resolve(worker.workspace,'verified-result.txt');
    const otherReady=resolve(coordinator.workspace,'other-ready.txt'),otherRelease=resolve(coordinator.workspace,'other-release.txt');
    const nonce=crypto.randomUUID();
    const waitCommand=(ready,release)=>`printf ready > '${ready}'; for i in $(seq 1 180); do test -f '${release}' && break; sleep 1; done; test -f '${release}'`;
    const task=`你是专业员工，只做本任务，不委派、不向负责人发额外消息。用原生 shell 前台执行（超时至少 180 秒，不放后台）：${waitCommand(ready,release)}。命令成功后，用原生工具向 '${file}' 写入且仅写入 ${nonce}，不加换行；再读回核对。最终回答说明核对结果并列出该文件绝对路径，让网络自动回传完成事件。`;
    await bridge.receive(frame('qa-a',`请安排专业员工 worker 完成下面工作。首次执行时使用 local-network 的 send_message（to=worker）唤醒这个当前空闲的员工，完整传达以下任务：\n${task}\n派单后仅调用 reply_user 回复 ASSIGNED，然后立即结束本轮，内部最终输出仅写 INTERNAL，不等待或查询员工结果。\n之后收到该员工完成的内部事件时，请用 get_result 查结果，再用原生工具读回文件验收；验收通过后仅调用 reply_user 回复 VERIFIED: 加上文件中完整代号，并在最终内部记录列出文件绝对路径以发送附件。后续验收轮不要重新派单，不重复已经发送的内容。`));
    await until(()=>exists(ready),`${runtime} worker tool started`);
    const origin=[...bridge.inbox.items.values()].find(item=>!item.kind);
    await until(()=>origin.status==='completed',`${runtime} coordinator returned before employee`);
    const parent=service.network.runs.get(origin.runId);
    const child=[...service.network.runs.values()].find(run=>run.agentId==='worker');
    assert.equal(parent.status,'completed');assert.equal(child.status,'running');
    assert.equal(child.parentRunId,parent.runId);assert.equal(child.originMessageId,parent.originMessageId);
    assert.ok(messages.some(message=>message.chatid==='qa-a'&&message.text==='ASSIGNED'));
    log('idle employee woke with parent linkage; ExampleBot ended while employee still working');
    await bridge.receive(frame('qa-b',`这是一项独立任务，不委派。用原生 shell 前台执行（超时至少 180 秒，不放后台）：${waitCommand(otherReady,otherRelease)}。命令返回后仅调用 reply_user 回复 OTHER_DONE，最终内部文字写 INTERNAL。不要处理别的群的任务。`));
    await until(()=>exists(otherReady),`${runtime} unrelated group executing`);
    await writeFile(release,'continue');
    const review=await until(()=>[...service.network.runs.values()].find(run=>run.continuationOfRunId===parent.runId),`${runtime} completion wakes review`);
    assert.equal(review.originMessageId,parent.originMessageId);assert.equal(review.parentRunId,undefined);
    await until(()=>[...bridge.inbox.items.values()].some(item=>item.kind==='member_completed'&&['completed','failed'].includes(item.status)),`${runtime} review completed`);
    const event=[...bridge.inbox.items.values()].find(item=>item.kind==='member_completed');
    assert.equal(event.status,'completed',event.error);assert.equal(review.status,'completed',review.error);
    assert.equal(await readFile(file,'utf8'),nonce);
    assert.ok(messages.some(message=>message.chatid==='qa-a'&&contentValue(message.text,'VERIFIED:')===nonce));
    assert.ok(JSON.stringify(review.events).includes('get_result'),'review queried the completed execution');
    assert.ok(uploads.some(upload=>upload.filename==='verified-result.txt'&&upload.text===nonce));
    assert.ok(media.some(item=>item.chatid==='qa-a'&&item.id==='verified-result.txt'));
    assert.ok(!injections.some(event=>event.sessionKey==='wecom:group:qa-b'&&event.messages.some(message=>message.resultRunId===child.runId)));
    await writeFile(otherRelease,'continue');
    await until(()=>[...bridge.inbox.items.values()].every(item=>['completed','failed'].includes(item.status)),`${runtime} all entries settled`);
    for(const item of bridge.inbox.items.values())assert.equal(item.status,'completed',item.error);
    await bridge.outbox.running;
    assert.deepEqual(messages.filter(message=>message.chatid==='qa-b').map(message=>message.text),['OTHER_DONE']);
    await bridge.completions.handle(service.network.snapshot(child));
    assert.equal(service.network.runs.size,4,'one original turn, one employee, one unrelated turn and one review; no wake loop');
    assert.equal([...bridge.inbox.items.values()].filter(item=>item.kind==='member_completed').length,1);
    Object.assign(entry,{passed:true,idleMessagePreservesParent:true,coordinatorEndedBeforeWorker:true,automaticReview:true,originalGroupReply:true,
      originalWorkerFileDelivered:true,unrelatedChatUnaffected:true,noDuplicateEventOrWakeLoop:true,parentRunId:parent.runId,workerRunId:child.runId,reviewRunId:review.runId});
    log('passed completion wake, real review, file delivery and source isolation');
  }catch(error){entry.error=redact(error.message);report.passed=false;log(`FAILED: ${entry.error}`);}
  finally {
    entry.messages=messages;entry.uploads=uploads;entry.media=media;entry.injections=injections;
    entry.runs=service?[...service.network.runs.values()].map(run=>service.network.snapshot(run)):[];
    await bridge?.close();await service?.close();await bridge?.worker.running;await bridge?.statusQueue;
    report.cases.push(entry);await writeJson(resolve(INSTANCE_ROOT,'verification',`${tag}-${runtime}.json`),entry);
  }
}));
report.endedAt=new Date().toISOString();await writeJson(resolve(INSTANCE_ROOT,'verification',`${tag}.json`),report);
console.log(JSON.stringify({passed:report.passed,report:`verification/${tag}.json`}));if(!report.passed)process.exitCode=1;
