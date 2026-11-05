import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SharedMemory } from '../src/shared-memory.mjs';
import { SharedContext } from '../src/shared-context.mjs';
import { INSTANCE_ROOT } from '../../../src/paths.mjs';

async function fixture(t) {
  const base=resolve(INSTANCE_ROOT,'.local/tests');await mkdir(base,{recursive:true});
  const root=await mkdtemp(resolve(base,'memory-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const memory=await SharedMemory.open(root);
  const a={id:'input-a',runId:'run-a',agentId:'assistant',chatid:'group-a',body:{chattype:'group'},userid:'owner'};
  const b={id:'input-b',runId:'run-b',agentId:'assistant',chatid:'owner',body:{chattype:'single'},userid:'owner'};
  const network={runs:new Map(),getResult:async()=>null};const inbox={items:new Map([[a.id,a],[b.id,b]])};
  const context=new SharedContext(network,inbox,{items:new Map(),forRun:()=>[]},'assistant',memory);
  return {root,memory,network,inbox,context,a,b};
}
test('shared recall persists concurrent writes and deduplicates source records after reopening',async t=>{
  const {root,memory}=await fixture(t);
  await Promise.all(Array.from({length:12},(_,i)=>memory.record(`event-${i}`,{type:'user',text:`fact-${i}`})));
  await memory.record('event-0',{text:'must not overwrite history'});
  const restored=await SharedMemory.open(root);assert.equal(restored.entries.size,12);assert.equal(restored.sequence,12);
  assert.equal(new Set([...restored.entries.values()].map(x=>x.sequence)).size,12);
  const zero=[...restored.entries.values()].find(x=>x.key==='event-0');assert.equal(zero.text,'fact-0');
  assert.equal((await stat(resolve(root,`${zero.id}.json`))).mode&0o777,0o600);
});
test('new private execution receives earlier group facts and active executions receive later cross-chat updates once',async t=>{
  const {context,memory,network,a,b}=await fixture(t);
  await memory.record('fact-a',{type:'user',source:{chatid:a.chatid,chattype:'group'},text:'project secret is RANDOM-ALPHA'});
  const run={runId:'run-b',agentId:'assistant',originMessageId:b.id,status:'running',input:'continue'};network.runs.set(run.runId,run);
  assert.match(context.prepare(run),/RANDOM-ALPHA/);
  await memory.record('new-a',{type:'user',source:{chatid:a.chatid,chattype:'group'},text:'budget changed to 7'});
  const updates=context.updates(run);assert.equal(updates.length,1);assert.match(updates[0].message,/budget changed to 7/);
  assert.match(updates[0].message,/"currentConversation":false/);assert.deepEqual(context.updates(run),[]);
});
test('parallel work receives same-chat updates without echoing its own replies or duplicating directly injected inputs',async t=>{
  const {context,memory,network,a}=await fixture(t);
  const child={runId:'child',agentId:'assistant',originMessageId:a.id,status:'running',input:'parallel work'};network.runs.set(child.runId,child);
  context.prepare(child);
  await memory.record('child-reply',{type:'assistant',runId:'child',text:'self'});
  await memory.record('direct-input',{type:'user',queueItemId:'direct-id',source:{chatid:a.chatid,chattype:'group'},text:'already injected'});
  assert.deepEqual(context.updates(child,[{id:'direct-id'}]),[]);
  await memory.record('supplement',{type:'user',queueItemId:'new-input',source:{chatid:a.chatid,chattype:'group'},text:'update parallel task'});
  const updates=context.updates(child);assert.match(updates[0].message,/update parallel task/);assert.match(updates[0].message,/"currentConversation":true/);
});
test('bounded prompt excerpts retain complete source files for older and longer memories',async t=>{
  const {root,memory}=await fixture(t);const full='x'.repeat(2000)+'THE-END';const entry=await memory.record('long',{type:'user',text:full});
  const rendered=memory.render([entry])[0];assert.equal(rendered.truncated,true);assert.ok(rendered.text.length<full.length);
  assert.equal(JSON.parse(await readFile(rendered.record,'utf8')).text,full);assert.ok(rendered.record.startsWith(root));
});
test('failed storage does not advance the visible memory cursor and can be retried',async t=>{
  const {root,memory}=await fixture(t);const blocked=resolve(root,'not-a-directory');await writeFile(blocked,'blocked');
  memory.directory=blocked;
  await assert.rejects(memory.record('retry-me',{text:'new fact'}));
  assert.equal(memory.sequence,0);assert.equal(memory.entries.size,0);
  memory.directory=root;
  const entry=await memory.record('retry-me',{text:'new fact'});assert.equal(entry.sequence,1);
  assert.equal(memory.after(0)[0].text,'new fact');
});
test('filtered own replies cannot hide a later supplement at the last hook boundary',async t=>{
  const {context,memory,network,a}=await fixture(t);
  const run={runId:'child',agentId:'assistant',originMessageId:a.id,status:'running',input:'work'};network.runs.set(run.runId,run);
  context.prepare(run);
  for(let i=0;i<13;i++)await memory.record(`self-${i}`,{type:'assistant',runId:run.runId,text:'already sent'});
  await memory.record('latest',{type:'user',queueItemId:'supplement',source:{chatid:a.chatid,chattype:'group'},text:'use the updated deadline'});
  assert.match(context.updates(run)[0].message,/updated deadline/);assert.deepEqual(context.updates(run),[]);
});
