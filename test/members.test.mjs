import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AgentNetwork } from '../src/network.mjs';
import { readJson, writeJson } from '../src/paths.mjs';
import { startServer } from '../src/server.mjs';
import { codexReport } from '../src/codex-discovery.mjs';

const key = 'a'.repeat(64);
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(),'member-test-'));
  await writeJson(resolve(root,'network.json'),{workspaceRoot:'workspaces',
    templates:{lead:{runtime:'claude',manager:true,capabilities:[],instructions:'lead'},worker:{runtime:'dsh',capabilities:[],instructions:'work'}},
    agents:{assistant:{template:'lead'},engineer:{template:'worker'}}});
  const network = await AgentNetwork.create({root,runtimeFactory:agent => ({agent,readableFiles:new Set(),
    async start(){},async run(){return {answer:'routed to '+agent.id,stopReason:'end_turn'};},async cancel(){},stop(){}})});
  const service = await startServer({network});
  t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
  const {url,token} = service.endpoint;
  const owner = (await readJson(resolve(root,'.local/release-control.json'))).token;
  const request = async(route,bearer,body) => {
    const res = await fetch(url+route,{method:'POST',headers:{authorization:'Bearer '+bearer},body:JSON.stringify(body)});
    return {code:res.status,value:await res.json()};
  };
  const project = resolve(root,'selected');
  const form = {id:'other',name:'Other agent',runtime:'dsh',consent:true,projects:[project]};
  const submit = overrides => request('/members/self',key,{action:'join',id:form.id,application:{...form,...overrides}});
  const self = (action,fields={}) => request('/members/self',key,{action,id:form.id,...fields});
  const admin = (action,fields={}) => request('/members/owner',owner,{action,...fields});
  return {root,service,network,project,form,url,token,owner,request,submit,self,admin};
}
function report(project,name='audit') {
  return {project,tools:[{name,source:'declared'}],sessions:[{id:'thread-1',purpose:'Verify deploy',source:'declared'}]};
}

test('only explicit project consent and owner approval publish a discoverable, revocable report',async t=>{
  const f=await fixture(t);
  assert.equal((await f.submit({consent:false})).code,400);
  assert.equal((await f.submit({projects:[]})).code,400);
  const joins=await Promise.all([f.submit({}),f.submit({})]);
  assert.ok(joins.every(r=>r.value.status==='pending'));
  assert.equal((await f.self('report',{report:report('/outside')})).code,400);
  assert.equal((await f.self('report',{report:{...report(f.project),transcript:'excluded'}})).code,400);
  assert.equal((await f.self('report',{report:report(f.project)})).code,200);
  assert.equal((await f.admin('pending')).value.length,1);
  assert.deepEqual((await f.admin('query')).value.members,[]);
  const snapshot=await f.request('/team',f.token,{action:'status'});
  assert.equal(snapshot.value.pendingMemberships,1);
  assert.deepEqual(snapshot.value.externalMembers,[]);
  assert.equal((await f.request('/members/owner',key,{action:'approve',id:'other'})).code,401);
  assert.equal((await f.request('/members/owner',f.token,{action:'approve',id:'other'})).code,401);
  assert.equal((await f.request('/catalog',key,{})).code,401);
  assert.equal((await f.request('/members/self','b'.repeat(64),{action:'status',id:'other'})).code,400);
  assert.equal((await f.admin('approve',{id:'other'})).code,200);
  const match=(await f.admin('query',{query:'deploy'})).value.members[0];
  assert.equal(match.reports[0].sessions[0].purpose,'Verify deploy');
  const byTool=(await f.admin('query',{query:'audit'})).value.members[0];
  assert.equal(byTool.reports[0].sessions[0].purpose,'Verify deploy');
  assert.equal(match.executionAgent,null);
  await assert.rejects(f.network.send({to:'member:other',message:'hello'}),/no execution binding/);
  assert.equal((await f.submit({projects:['/else']})).code,400);
  assert.equal((await f.self('report',{report:report(f.project,'updated')})).code,200);
  assert.deepEqual((await f.admin('query',{query:'audit'})).value.members,[]);
  assert.equal((await f.admin('revoke',{id:'other'})).code,200);
  assert.deepEqual((await f.admin('query')).value.members,[]);
  assert.equal((await f.self('report',{report:report(f.project)})).code,400);
  const disk=await readJson(resolve(f.root,'.local/member-directory.json'));
  assert.deepEqual(disk.entries.other.reports,[]);assert.deepEqual(disk.entries.other.projects,[]);
  assert.ok(!JSON.stringify(disk).includes(key));
});

test('approved execution bindings use existing employee workspaces and runs; leaving removes the route',async t=>{
  const f=await fixture(t);
  await f.submit({});
  assert.equal((await f.admin('approve',{id:'other',agent:'assistant'})).code,400);
  assert.equal((await f.admin('approve',{id:'other',agent:'engineer'})).code,200);
  const delegated=await f.network.delegate({target:'member:other',message:'work'});
  await f.network.runs.get(delegated.runId).settled;
  assert.equal((await f.network.getResult(delegated.runId)).answer,'routed to engineer');
  assert.equal(delegated.workspace,f.network.catalog.get('engineer').workspace);
  assert.equal((await f.self('leave')).code,200);
  await assert.rejects(f.network.delegate({target:'member:other',message:'late'}),/not approved/);
});

test('Codex discovery filters exact cwd, pages normal and archived titles and reads only tool names',async t=>{
  const project=await mkdtemp(resolve(tmpdir(),'codex-project-'));
  t.after(()=>rm(project,{recursive:true,force:true}));
  await writeFile(resolve(project,'package.json'),JSON.stringify({scripts:{verify:'secret-command-not-a-name'}}));
  const calls=[];
  const client={async call(method,args){
    calls.push([method,args]);
    if(method==='thread/list'){
      assert.equal(args.cwd,project);assert.equal(args.useStateDbOnly,true);
      if(args.archived)return {data:[{id:'old',name:'Old purpose',cwd:project}],nextCursor:null};
      if(args.cursor)return {data:[{id:'untitled',name:null,preview:'never use me',cwd:project}],nextCursor:null};
      return {data:[{id:'known',name:'Build release',cwd:project,turns:['private content'],preview:'never use me'},
        {id:'foreign',name:'Foreign title',cwd:'/other'}],nextCursor:'page-2'};
    }
    if(method==='skills/list')return {data:[{cwd:project,skills:[{name:'inspect',enabled:true,path:'/private/location'},{name:'disabled',enabled:false}]}]};
    if(method==='mcpServerStatus/list')return {data:[{name:'calendar',tools:{read:{description:'secret metadata'}},authStatus:'private'}]};
    throw new Error('Unexpected RPC '+method);
  }};
  const result=await codexReport(project,client);
  assert.deepEqual(result.sessions.map(s=>s.id),['known','untitled','old']);
  assert.equal(result.sessions[1].purpose,null);assert.equal(result.sessions[2].archived,true);
  assert.deepEqual(result.tools.map(x=>x.name),['verify','inspect','calendar.read']);
  assert.doesNotMatch(JSON.stringify(result),/secret|never use|foreign|private|disabled/i);
  assert.ok(calls.every(([m])=>['thread/list','skills/list','mcpServerStatus/list'].includes(m)));
});

test('membership decisions by a network agent require ExampleBot working for the bound owner',async t=>{
  const f=await fixture(t);await f.submit({});
  const decide=()=>f.request('/members/manager',f.token,{from:'assistant',action:'approve',id:'other'});
  assert.equal((await decide()).code,400);
  const run={runId:'fixture-live',agentId:'assistant',status:'running'};
  f.network.runs.set(run.runId,run);f.network.busy.set('assistant',run.runId);
  let user='group-member';
  f.network.gate.channel={coordinatorId:'assistant',ownsRun:()=>user==='owner'};
  assert.equal((await decide()).code,400);
  user='owner';assert.equal((await decide()).value.status,'approved');
  assert.equal((await f.request('/members/manager',f.token,{from:'engineer',action:'query'})).code,400);
  f.network.runs.delete(run.runId);f.network.busy.clear();f.network.gate.channel=null;
});
