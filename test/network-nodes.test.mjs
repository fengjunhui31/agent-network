import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentNetwork } from '../src/network.mjs';
import { startServer } from '../src/server.mjs';
import { writeJson,readJson } from '../src/paths.mjs';
import { callPeer } from '../src/peer-transport.mjs';

async function eventually(f) {
  for(let i=0;i<200;i++){const result=f();if(result)return result;await delay(5);}
  throw new Error('Node fixture timed out');
}
async function fixture(t) {
  const root=await mkdtemp(resolve(tmpdir(),'node-mode-'));
  const hosts={};
  class Runtime {
    constructor(agent){this.agent=agent;}
    async start(){}
    run(text){this.text=text;return new Promise(resolve=>{this.done=answer=>resolve({answer,stopReason:'end_turn'});});}
    async cancel(){this.done?.('cancelled');}
    stop(){this.done?.('stopped');}
  }
  for(const name of ['a','b']){
    const home=resolve(root,name);await mkdir(home);
    await writeJson(resolve(home,'network.json'),{workspaceRoot:'workspaces',coordinatorId:name+'-leader',
      templates:{lead:{manager:true,runtime:'dsh',capabilities:[],instructions:'coordinate'},worker:{runtime:'dsh',capabilities:[],instructions:'work'}},
      agents:{[name+'-leader']:{template:'lead'},[name+'-private-worker']:{template:'worker'}}});
    const h={home,calls:[],async open(){
      this.network=await AgentNetwork.create({root:home,runtimeFactory:agent=>{const rt=new Runtime(agent);this.calls.push(rt);return rt;}});
      this.service=await startServer({network:this.network});
      this.id=this.network.peers.id;this.peers=this.network.peers;
    },async close(){if(this.service){await this.service.close();this.service=null;}}};
    await h.open();hosts[name]=h;
  }
  t.after(async()=>{await Promise.all(Object.values(hosts).map(h=>h.close()));await rm(root,{recursive:true,force:true});});
  const {a,b}=hosts;
  const join=()=>b.peers.manage({action:'join',peer:a.id,id:'studio',remoteAlias:'hub',name:'Studio',consent:true});
  const approve=()=>a.peers.manage({action:'approve',id:'studio'});
  return {a,b,join,approve};
}

test('independent networks expose exactly one opt-in text contact and keep local rosters private',async t=>{
  const {a,b,join,approve}=await fixture(t);
  await assert.rejects(b.peers.join({peer:a.id,id:'studio',remoteAlias:'hub',name:'Studio',consent:false}),/consent/);
  await assert.rejects(b.peers.join({peer:b.id,id:'studio',remoteAlias:'hub',name:'Studio',consent:true}),/different network/);
  await Promise.all([join(),join()]);
  assert.deepEqual((await a.peers.manage({action:'pending'})).map(n=>n.address),['node:studio']);
  assert.equal((await b.peers.manage({action:'query'})).length,1);
  await assert.rejects(a.peers.transmit('studio','premature'),/not approved/);
  await assert.rejects(b.peers.transmit('hub','premature'),/consent/);
  await assert.rejects(b.peers.decide('hub','approve'),/receiving network/);
  await approve();
  assert.equal((await b.peers.inspect('hub')).canMessage,true);
  const contact=(await a.peers.manage({action:'query'}))[0];
  assert.deepEqual(Object.keys(contact).sort(),['mode','address','name','networkId','direction','status','updatedAt'].sort());
  assert.doesNotMatch(JSON.stringify(contact),/worker|workspace|project|secret|runtime|leader|reports/i);
  const pair=await b.peers.find('hub');
  await assert.rejects(callPeer(a.id,b.id,pair,'catalog'),/Invalid|enum/);
  await assert.rejects(callPeer(a.id,b.id,{...pair,secret:'e'.repeat(64)},'status'),/credential/);
  const body=await fetch(a.service.endpoint.url+'/nodes/owner',{method:'POST',headers:{authorization:'Bearer '+pair.secret},body:'{"action":"query"}'});
  assert.equal(body.status,401);
  assert.equal((await stat(resolve(a.home,'.local/network-links.json'))).mode & 0o777,0o600);
  await assert.rejects(a.network.delegate({target:'node:studio',message:'direct task'}),/send_message/);
});

test('two real servers route a reply into the exact live initiating run without exposing its local run ID or chat',async t=>{
  const {a,b,join,approve}=await fixture(t);await join();await approve();
  const parent=await a.network.delegate({target:'a-leader',sessionKey:'wecom:private:original',message:'request'});
  const other=await a.network.delegate({target:'a-leader',sessionKey:'wecom:private:other',message:'separate request'});
  await eventually(()=>a.calls.filter(rt=>rt.text).length===2);
  b.network.userContext={prepare(){throw new Error('Private shared context reached a peer turn');},updates(){throw new Error('Private updates reached a peer turn');}};
  await assert.rejects(a.network.send({to:'node:studio',from:'a-leader',fromSessionKey:'wecom:private:original',message:'bad',files:['/private']}),/text only/);
  const ack=await a.network.send({to:'node:studio',from:'a-leader',fromSessionKey:'wecom:private:original',message:'Find the result'});
  assert.deepEqual(ack,{accepted:true,address:'node:studio'});
  const rt=await eventually(()=>b.calls.find(rt=>rt.text));const incoming=[...b.network.runs.values()][0];
  assert.equal(incoming.from,'node:hub');assert.match(rt.text,/Find the result/);
  assert.doesNotMatch(rt.text,new RegExp(parent.runId+'|wecom:private:original|a-private-worker'));
  assert.deepEqual(b.network.receive('b-leader','PostToolUse',incoming.sessionKey).messages,[]);
  await b.network.send({to:'node:hub',from:'b-leader',fromSessionKey:incoming.sessionKey,message:'Found the result'});
  assert.deepEqual(a.network.receive('a-leader','PostToolUse','wecom:private:original').messages.map(m=>[m.from,m.message]),[['node:studio','Found the result']]);
  assert.equal(a.network.receive('a-leader','PostToolUse','wecom:private:other').messages.length,0);
  rt.done('private employee summary');await incoming.settled;
  assert.equal(a.network.runs.size,2);
  for(const run of [parent,other]){const r=a.network.runs.get(run.runId);a.calls.find(rt=>rt.agent.sessionKey===r.sessionKey).done('done');await r.settled;}
});

test('offline, restart, offline revocation and rejoining are scoped to the pair and do not replay messages',async t=>{
  const {a,b,join,approve}=await fixture(t);await join();await approve();
  const id=b.id,old=await a.peers.find('studio');
  await b.close();
  await assert.rejects(a.peers.transmit('studio','do not replay'),/offline/);
  assert.equal((await a.peers.decide('studio','revoke')).peerNotified,false);
  await b.open();assert.equal(b.id,id);assert.equal(b.network.runs.size,0);
  await assert.rejects(b.peers.transmit('hub','revoked'),/closed/);
  assert.equal((await b.peers.inspect('hub')).status,'revoked');
  await join();await approve();
  const newer=await a.peers.find('studio');assert.notEqual(newer.linkId,old.linkId);
  await assert.rejects(a.peers.transmit('studio','old run',{sessionKey:'peer:'+b.id+':'+old.linkId+':general'}),/original link/);
  assert.equal((await a.peers.manage({action:'query'})).length,1);
  await b.peers.decide('hub','leave');
  await assert.rejects(a.peers.transmit('studio','not accepted'),/not approved/);
  assert.equal(a.network.runs.size,0);assert.equal(b.network.runs.size,0);
});

test('a late reply does not attach to a different local conversation or return hidden results automatically',async t=>{
  const {a,b,join,approve}=await fixture(t);await join();await approve();
  const parent=await a.network.delegate({target:'a-leader',sessionKey:'wecom:old',message:'request'});
  const first=await eventually(()=>a.calls.find(rt=>rt.text));
  await a.network.send({to:'node:studio',from:'a-leader',fromSessionKey:'wecom:old',message:'prepare'});first.done('ended');
  await a.network.runs.get(parent.runId).settled;
  const next=await a.network.delegate({target:'a-leader',sessionKey:'wecom:old',message:'another task'});
  const remote=await eventually(()=>b.calls.find(rt=>rt.text));const incoming=[...b.network.runs.values()][0];
  await b.network.send({to:'node:hub',from:'b-leader',fromSessionKey:incoming.sessionKey,message:'late reply'});
  const late=await eventually(()=>a.calls.find(rt=>rt.text && rt.agent.sessionKey?.startsWith('peer:')));
  assert.match(late.text,/late reply/);assert.deepEqual(a.network.receive('a-leader','PostToolUse','wecom:old').messages,[]);
  remote.done('internal');late.done('recorded');(await eventually(()=>a.calls.find(rt=>rt.agent.sessionKey==='wecom:old' && rt.text?.includes('another task')))).done('other');await a.network.runs.get(next.runId).settled;
});
