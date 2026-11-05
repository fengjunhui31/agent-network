import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentNetwork } from '../../../src/network.mjs';
import { startServer } from '../../../src/server.mjs';
import { WecomBridge } from '../src/wecom.mjs';
import { INSTANCE_ROOT, writeJson } from '../../../src/paths.mjs';
import { executionKey } from '../../../src/sessions.mjs';

async function until(check) {
  for(let i=0;i<500;i++){const value=check();if(value)return value;await delay(5);}
  throw new Error('Completion fixture timed out');
}
async function fixture(t) {
  await mkdir(resolve(INSTANCE_ROOT,'.local/tests'),{recursive:true});
  const root=await mkdtemp(resolve(INSTANCE_ROOT,'.local/tests/completion-'));
  await writeJson(resolve(root,'network.json'),{workspaceRoot:'workspaces',
    templates:{coordinator:{runtime:'fake',manager:true,instructions:'coordinate',capabilities:[]},worker:{runtime:'fake',instructions:'work',capabilities:[]}},
    agents:{assistant:{template:'coordinator'},a:{template:'worker'},b:{template:'worker'}}});
  const f={root,messages:[],uploads:[],media:[],calls:[]};
  class Runtime {
    constructor(agent){this.agent=agent;this.readableFiles=new Set();}
    async start(){}
    run(message){this.message=message;this.activeRunId=f.network.activeRun(this.agent.id,this.agent.sessionKey).runId;f.calls.push({agent:this.agent,message});return new Promise((done,fail)=>{this.done=done;this.fail=fail;});}
    async cancel(){this.done?.({answer:'',stopReason:'cancelled'});}
    stop(){void this.cancel();}
  }
  class Client extends EventEmitter {
    connect(){this.emit('authenticated');}disconnect(){}
    async sendMessage(chatid,body){f.messages.push({chatid,text:body.markdown.content});return {errcode:0};}
    async replyStream(){return {errcode:0};}
    async uploadMedia(buffer,{filename}){f.uploads.push({text:buffer.toString(),filename});return {media_id:filename};}
    async sendMediaMessage(chatid,type,id){f.media.push({chatid,type,id});return {errcode:0};}
  }
  f.open=async(hold=false)=>{
    f.network=await AgentNetwork.create({root,hold,runtimeFactory:agent=>new Runtime(agent)});
    f.service=await startServer({network:f.network,saveEndpoint:false});
    f.bridge=new WecomBridge(f.network,new Client(),{agentId:'assistant',allowedUserIds:['owner'],enabledGroupIds:['group-a','group-b']},
      {configFile:resolve(root,'wecom.json'),statusFile:resolve(root,'status.json'),logFile:resolve(root,'events.jsonl'),inboxDirectory:resolve(root,'inbox')}).start();
    await f.bridge.ready;
  };
  f.close=async()=>{await f.bridge.close();await f.service.close();await f.bridge.worker.running;await f.bridge.statusQueue;};
  f.ready=run=>until(()=>f.network.runtimes.get(executionKey(run.agentId,run.sessionKey))?.activeRunId===run.runId).then(()=>run);
  f.input=async(chatid='group-a',text='original user task')=>{
    const ids=new Set(f.network.runs.keys());
    await f.bridge.receive({body:{msgid:crypto.randomUUID(),chattype:'group',chatid,from:{userid:'owner'},msgtype:'text',text:{content:text}}});
    return f.ready(await until(()=>[...f.network.runs.values()].find(run=>!ids.has(run.runId))));
  };
  f.child=async(parent,target='a',parallel=false)=>{
    const result=await f.network.delegate({from:parent.agentId,fromSessionKey:parent.sessionKey,target,parallel,message:'produce verified artifact'});
    return f.ready(f.network.runs.get(result.runId));
  };
  f.finish=async(run,answer='INTERNAL')=>{f.network.runtimes.get(executionKey(run.agentId,run.sessionKey)).done({answer,stopReason:'end_turn'});await run.settled;};
  f.reply=(run,message)=>f.network.replyUser({from:run.agentId,fromSessionKey:run.sessionKey,message});
  f.review=parent=>until(()=>[...f.network.runs.values()].find(run=>run.continuationOfRunId===parent.runId&&run.status==='running')).then(f.ready);
  f.events=()=>[...f.bridge.inbox.items.values()].filter(item=>item.kind==='member_completed');
  await f.open();t.after(async()=>{await f.close();await rm(root,{recursive:true,force:true});});return f;
}

test('a completed employee injects one durable event into the exact active coordinator without an extra turn',async t=>{
  const f=await fixture(t);const parent=await f.input();const child=await f.child(parent);
  await f.finish(child,'verified result');
  const event=f.events()[0];assert.equal(event.status,'attached');assert.equal(event.runId,parent.runId);
  const received=f.network.receive('assistant','PostToolUse',parent.sessionKey);
  assert.equal(received.messages.filter(x=>x.resultRunId===child.runId).length,1);
  assert.deepEqual(parent.resultRunIds,[child.runId]);
  await f.reply(parent,'checked');await f.finish(parent);await f.bridge.worker.running;await f.bridge.completions.settlements;
  assert.equal(event.status,'completed');assert.equal(f.network.runs.size,2);
  assert.deepEqual(f.messages,[{chatid:'group-a',text:'checked'}]);
});

test('late completion resumes ExampleBot in the original chat and can deliver the original employee file',async t=>{
  const f=await fixture(t);const parent=await f.input();const child=await f.child(parent);
  const file=resolve(child.workspace,'result.txt');await writeFile(file,'verified employee artifact');
  await f.reply(parent,'I will return with the result');await f.finish(parent);await f.bridge.worker.running;
  const other=await f.input('group-b','unrelated task');
  await f.finish(child,'result ready');const review=await f.review(parent);
  assert.equal(review.originMessageId,parent.originMessageId);assert.equal(review.parentRunId,undefined);
  assert.equal(review.originRunId,parent.originRunId);assert.equal(review.sessionKey,parent.sessionKey);
  assert.match(review.input,/original user task/);assert.match(review.input,/不是用户的新请求/);
  assert.equal(f.network.receive('assistant','PostToolUse',other.sessionKey).messages.filter(x=>x.resultRunId).length,0);
  await f.reply(review,'accepted artifact');await f.finish(review,`INTERNAL\n${file}`);
  await until(()=>f.events()[0].status==='completed');
  assert.equal(f.messages.find(x=>x.text==='accepted artifact').chatid,'group-a');
  assert.deepEqual(f.uploads,[{text:'verified employee artifact',filename:'result.txt'}]);
  assert.equal(f.media[0].chatid,'group-a');
  await f.reply(other,'other finished');await f.finish(other);await f.bridge.worker.running;
  assert.equal(f.events().length,1);assert.equal(f.network.runs.size,4);
});

test('an accepted result missed by the final hook becomes a new review instead of disappearing',async t=>{
  const f=await fixture(t);const parent=await f.input();const child=await f.child(parent);
  await f.finish(child,'late hook result');assert.equal(f.events()[0].status,'attached');
  await f.reply(parent,'working');await f.finish(parent);
  const review=await f.review(parent);assert.match(review.input,/late hook result/);
  await f.reply(review,'checked after wake');await f.finish(review);await f.bridge.worker.running;
  assert.equal(f.events()[0].status,'completed');assert.equal(f.network.runs.size,3);
});

test('a late result waits behind an unrelated successor in the same chat without entering that task',async t=>{
  const f=await fixture(t);const parent=await f.input();const child=await f.child(parent);
  await f.reply(parent,'working');await f.finish(parent);await f.bridge.worker.running;
  const successor=await f.input('group-a','a different request');
  await f.finish(child,'old task result');assert.equal(f.events()[0].status,'pending');
  assert.equal(f.network.receive('assistant','PostToolUse',successor.sessionKey).messages.filter(x=>x.resultRunId).length,0);
  assert.equal(f.network.runs.size,3);
  await f.reply(successor,'different request done');await f.finish(successor);
  const review=await f.review(parent);assert.equal(review.originMessageId,parent.originMessageId);
  assert.notEqual(review.originMessageId,successor.originMessageId);
  await f.reply(review,'old task checked');await f.finish(review);await f.bridge.worker.running;
  assert.equal(f.events()[0].status,'completed');
});

test('two late results join the same original review; replaying a completion does not create another turn',async t=>{
  const f=await fixture(t);const parent=await f.input();const a=await f.child(parent,'a');const b=await f.child(parent,'b');
  await f.reply(parent,'working');await f.finish(parent);await f.bridge.worker.running;
  await f.finish(a,'A result');const review=await f.review(parent);
  await f.finish(b,'B result');assert.equal(f.events().find(x=>x.resultRunId===b.runId).status,'attached');
  f.network.receive('assistant','PostToolUse',review.sessionKey);
  assert.deepEqual(new Set(review.resultRunIds),new Set([a.runId,b.runId]));
  await f.reply(review,'both checked');await f.finish(review);await f.bridge.worker.running;
  await f.bridge.completions.handle(f.network.snapshot(a));
  assert.equal(f.network.runs.size,4);assert.equal(f.events().length,2);
  assert.ok(f.events().every(x=>x.status==='completed'));
});

test('a parallel ExampleBot parent can consume a completion without leaving an attached event stranded',async t=>{
  const f=await fixture(t);const root=await f.input();const parent=await f.child(root,'assistant',true);const worker=await f.child(parent);
  await f.finish(worker,'parallel worker result');
  assert.equal(f.events()[0].runId,parent.runId);
  f.network.receive('assistant','PostToolUse',parent.sessionKey);await f.reply(parent,'parallel checked');await f.finish(parent);
  await f.bridge.completions.settlements;assert.equal(f.events()[0].status,'completed');
  await f.reply(root,'root checked');await f.finish(root);await f.bridge.worker.running;
  assert.equal(f.network.runs.size,3);assert.equal(f.events().length,1);
});

test('a queued completion survives reopening and reads saved employee results without rerunning the employee',async t=>{
  const f=await fixture(t);const parent=await f.input();const child=await f.child(parent);
  const file=resolve(child.workspace,'persisted.txt');await writeFile(file,'saved artifact');
  await f.reply(parent,'working');await f.finish(parent);await f.bridge.worker.running;
  await f.bridge.worker.close();await f.finish(child,'saved result');assert.equal(f.events()[0].status,'pending');
  const employeeCalls=f.calls.filter(x=>x.agent.id==='a').length;
  await f.close();await f.open();const review=await f.review(parent);
  assert.equal((await f.network.getResult(child.runId)).answer,'saved result');
  await f.reply(review,'resumed review');await f.finish(review,`INTERNAL\n${file}`);await f.bridge.worker.running;
  assert.equal(f.calls.filter(x=>x.agent.id==='a').length,employeeCalls);
  assert.equal(f.events()[0].status,'completed');assert.equal(f.uploads[0].text,'saved artifact');
  assert.equal(f.messages.find(x=>x.text==='resumed review').chatid,'group-a');
  assert.ok(![...f.bridge.context.memory.entries.values()].some(x=>x.key===`input:${f.events()[0].id}`));
});

test('employee failures wake a review; an explicitly stopped coordinator is not revived by late results',async t=>{
  const f=await fixture(t);const parent=await f.input();const child=await f.child(parent);
  await f.reply(parent,'working');await f.finish(parent);await f.bridge.worker.running;
  f.network.runtimes.get(executionKey(child.agentId,child.sessionKey)).fail(new Error('fixture worker failure'));await child.settled;
  const review=await f.review(parent);assert.match(review.input,/fixture worker failure/);
  await f.reply(review,'failure explained');await f.finish(review);await f.bridge.worker.running;
  const cancelled=await f.input();const late=await f.child(cancelled,'b');
  await f.network.cancel('assistant',cancelled.sessionKey);await cancelled.settled;await f.bridge.worker.running;
  await f.finish(late,'do not revive cancelled work');
  assert.equal(f.events().length,1);assert.equal(f.network.busy.size,0);
});

test('a late nested worker can return to ExampleBot when its professional parent has already ended',async t=>{
  const f=await fixture(t);const parent=await f.input();const a=await f.child(parent,'a');const b=await f.child(a,'b');
  await f.finish(a,'A finished before B');f.network.receive('assistant','PostToolUse',parent.sessionKey);
  await f.reply(parent,'A checked');await f.finish(parent);await f.bridge.worker.running;
  await f.finish(b,'late nested result');const review=await f.review(parent);
  assert.match(review.input,/late nested result/);assert.equal(review.originMessageId,parent.originMessageId);
  await f.reply(review,'nested checked');await f.finish(review);await f.bridge.worker.running;
  assert.equal(f.events().length,2);
});

test('release drain finishes child work and reopens pending chat and completion events on the same instance', async t => {
  const f = await fixture(t);
  const parent = await f.input('group-a', 'original task');
  f.network.gate.command('drain', f.network);
  await assert.rejects(f.network.delegate({ target: 'b', message: 'new external task' }), /upgrade/);
  const child = await f.child(parent);
  await f.bridge.receive({body:{msgid:'during-drain',chattype:'group',chatid:'group-b',from:{userid:'owner'},msgtype:'text',text:{content:'waiting request'}}});
  const queued = [...f.bridge.inbox.items.values()].find(x => x.messageId === 'during-drain');
  assert.equal(queued.status, 'pending');
  assert.equal(f.network.gate.status(f.network).readyToStop, false);
  await f.reply(parent, 'The team is working'); await f.finish(parent); await f.bridge.worker.running;
  assert.deepEqual(f.network.gate.status(f.network).activeRuns, [child.runId]);
  await f.finish(child, 'employee result'); await f.bridge.completions.settlements;
  await until(() => f.network.gate.status(f.network).readyToStop);
  assert.equal(f.events()[0].status, 'pending');
  const workspace = parent.workspace;
  await f.close(); await f.open(true);
  assert.equal(f.network.gate.status(f.network).phase, 'holding');
  assert.equal(f.network.runs.size, 0);
  assert.equal(f.bridge.inbox.items.get(queued.id).status, 'pending');
  const saved = await f.bridge.outbox.enqueue({chatid:'group-b', kind:'text', content:'saved until ready', origin:'system'});
  assert.equal(f.bridge.outbox.items.get(saved.messageId).status, 'pending');
  assert.equal(f.messages.some(x => x.text === 'saved until ready'), false);
  f.network.gate.command('resume', f.network);
  const review = await f.review(parent);
  const other = await until(() => [...f.network.runs.values()].find(r => r.originMessageId === queued.id));
  await f.ready(other);
  assert.equal(review.workspace, workspace);
  assert.equal((await f.network.getResult(child.runId)).answer, 'employee result');
  await f.reply(review, 'reviewed'); await f.finish(review);
  await f.reply(other, 'handled waiting request'); await f.finish(other);
  await f.bridge.worker.running;
  assert.equal(f.bridge.inbox.items.get(queued.id).attempts, 1);
  assert.equal(f.events()[0].status, 'completed');
  assert.deepEqual(f.messages.map(x => [x.chatid, x.text]), [
    ['group-a','The team is working'], ['group-b','saved until ready'], ['group-a','reviewed'], ['group-b','handled waiting request']]);
});
