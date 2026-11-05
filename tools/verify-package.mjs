import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { ROOT } from '../src/paths.mjs';

const pkg=JSON.parse(await readFile(join(ROOT,'package.json'),'utf8'));
const temp=await mkdtemp(join(tmpdir(),'agent-network-package-test-'));
const instance=join(temp,'instance');
const executable=join(temp,'node_modules','.bin','agent-network');
const releaseExecutable=join(temp,'node_modules','.bin','agent-network-release');
const runRelease=(...args)=>execFileSync(releaseExecutable,args,{cwd:temp,encoding:'utf8',timeout:180000});
const run=(...args)=>execFileSync(executable,args,{cwd:temp,encoding:'utf8',timeout:180000});
let activated=false;
try {
  execFileSync('npm',['install','--no-save','--ignore-scripts','--no-audit','--no-fund','--offline','--prefix',temp,
    join(ROOT,'dist','shiyanjia-agent-network-'+pkg.version+'.tgz')],{stdio:'pipe',timeout:60000});
  assert.equal(run('--version').trim(),pkg.version);
  assert.equal(runRelease('--version').trim(),pkg.version);
  assert.match(runRelease('--help'),/schedule/);
  run('init',instance);
  const config=JSON.parse(await readFile(join(instance,'network.json'),'utf8'));
  const selected=config.agents[config.coordinatorId];
  delete config.agents[config.coordinatorId];
  config.coordinatorId='research-lead';
  config.agents[config.coordinatorId]={...selected,name:'阿岚',instructions:'你负责研究组的任务分派和验收。'};
  const authored=JSON.stringify(config,null,2);
  await writeFile(join(instance,'network.json'),authored);
  run('init',instance);assert.equal(await readFile(join(instance,'network.json'),'utf8'),authored);
  runRelease('activate',instance);activated=true;
  assert.deepEqual(JSON.parse(runRelease('status',instance)),JSON.parse(run('status',instance)));
  const status=JSON.parse(run('status',instance));
  assert.equal(status.running,true);assert.equal(status.current.version,pkg.version);assert.equal(status.health.buildId,status.current.buildId);
  assert.match(run('member',instance,'guide'),/主协调者/);
  const catalog=JSON.parse(run('agent',instance,'list'));
  const directory=JSON.parse(run('member',instance,'query'));
  assert.equal(directory.coordinator,'research-lead');
  const expected=join(await realpath(instance),'.local/workspaces/research-lead');
  assert.ok(catalog.agents.some(a=>a.id==='research-lead' && a.name==='阿岚' && a.workspace===expected));
  const persona=await readFile(join(expected,'AGENTS.md'),'utf8');
  assert.match(persona,/阿岚/);assert.doesNotMatch(persona,/示例机器人|ExampleBot/);
  const control=JSON.parse(await readFile(join(instance,'.local/release-control.json'),'utf8'));
  const health=await fetch(control.url+'/maintenance',{method:'POST',headers:{authorization:'Bearer '+control.token},body:'{"action":"status"}'});
  assert.equal(health.status,200);assert.equal((await health.json()).channelInfo,null);
  await assert.rejects(access(join(status.current.directory,'node_modules/@wecom/aibot-node-sdk')), {code:'ENOENT'});
  await assert.rejects(access(join(status.current.directory,'src/wecom.mjs')), {code:'ENOENT'});
  assert.equal(JSON.parse(run('channel',instance,'status')).enabled,false);
  run('stop',instance);activated=false;
  const before=await readFile(join(instance,'network.json'),'utf8');
  const adapter=JSON.parse(await readFile(join(ROOT,'packages/wecom/package.json'),'utf8'));
  run('channel',instance,'install','wecom',join(ROOT,'dist','shiyanjia-agent-network-wecom-'+adapter.version+'.tgz'));
  const selectedChannel=JSON.parse(run('channel',instance,'status'));
  assert.equal(await readFile(join(instance,'network.json'),'utf8'),before);
  assert.equal(selectedChannel.id,'wecom');assert.equal(selectedChannel.version,adapter.version);
  const slot=join(instance,'.local/channels',selectedChannel.slot,'node_modules');
  await access(join(slot,'@wecom/aibot-node-sdk/package.json'));
  await access(join(instance,'.local/wecom.example.json'));
  const {WecomBridge}=await import(pathToFileURL(join(slot,adapter.name,'src/wecom.mjs')));
  const {AgentNetwork}=await import(pathToFileURL(join(status.current.directory,'src/network.mjs')));
  const network=await AgentNetwork.create({root:instance});
  class Transport extends EventEmitter {
    connect(){this.emit('authenticated');} disconnect(){}
    async replyStream(frame,id,text){this.reply=text;return {errcode:0};}
  }
  const transport=new Transport();
  const bridge=new WecomBridge(network,transport,{agentId:directory.coordinator,allowedUserIds:['owner']}).start();
  try {
    await bridge.ready;
    await bridge.receive({body:{msgid:'package-probe',msgtype:'text',chattype:'single',from:{userid:'owner'},text:{content:'状态'}}});
    assert.match(transport.reply,/阿岚/);
    assert.equal(network.gate.status(network).channelInfo.id,'wecom');
  } finally {await bridge.close();await network.close();}
  run('channel',instance,'disable');
  run('start',instance);activated=true;
  assert.equal(JSON.parse(run('status',instance)).running,true);
  console.log(JSON.stringify({package:pkg.version,buildId:status.health.buildId,isolatedInstall:true,customCoordinator:directory.coordinator,
    coreHasWeComSdk:false,optionalWeCom:adapter.version,recordingTransport:true,disabledChannelRestart:true}));
} finally {
  if(activated)run('stop',instance);
  await rm(temp,{recursive:true,force:true});
}
