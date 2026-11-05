import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { startConfiguredChannel } from '../src/channels.mjs';
import { readJson, writeJson } from '../src/paths.mjs';
import { AgentNetwork } from '../src/network.mjs';
import { startServer } from '../src/server.mjs';

test('an instance starts without a channel and only loads its separately selected API v1 module', async t=>{
  const root=await mkdtemp(join(tmpdir(),'network-channel-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const network={root, gate:{}, catalog:{}};
  assert.equal(await startConfiguredChannel(network),null);
  await assert.rejects(startConfiguredChannel(network,'wecom'),/not installed/);
  const slot=randomUUID(),id='fixture',name='@shiyanjia/agent-network-fixture';
  const dir=join(root,'.local/channels',slot,'node_modules',name);
  await mkdir(dir,{recursive:true});
  await writeJson(join(dir,'package.json'),{name,main:'index.mjs',version:'1.0.0',agentNetworkChannel:{id,apiVersion:1}});
  await writeFile(join(dir,'index.mjs'),"export async function startChannel(){return {id:'fixture',activity(){return {ready:true}},ownsRun(){return false},resume(){},close(){}}}");
  const config=join(root,'.local/channel.json');
  await writeJson(config,{enabled:true,id,slot,version:'1.0.0'});
  assert.equal((await startConfiguredChannel(network)).id,'fixture');assert.equal(network.gate.channel,network.catalog.channel);
  await writeJson(config,{enabled:true,id,slot,version:'2.0.0'});await assert.rejects(startConfiguredChannel(network),/identity/);
  await writeJson(config,{enabled:false});assert.equal(await startConfiguredChannel(network),null);
});

test('startup publishes the selected channel in every fixed employee guide before the first task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'network-startup-guide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instance = {
    workspaceRoot: '.local/workspaces',
    templates: { staff: { capabilities: ['research'] } },
    agents: { lead: { template: 'staff', manager: true }, reviewer: { template: 'staff' } },
  };
  await writeJson(join(root, 'network.json'), instance);
  const network = await AgentNetwork.create({ root, hold: true });
  const slot = randomUUID();
  const module = join(root, '.local/channels', slot, 'node_modules/@shiyanjia/agent-network-fixture');
  await mkdir(module, { recursive: true });
  await writeJson(join(module, 'package.json'), {
    name: '@shiyanjia/agent-network-fixture', version: '1.0.0', main: 'index.mjs',
    agentNetworkChannel: { id: 'fixture', apiVersion: 1 },
  });
  await writeFile(join(module, 'index.mjs'), `
    export function startChannel() {
      return {id: 'fixture', features: ['review-channel'], activity() {return {ready: true}},
        ownsRun() {return false}, resume() {}, close() {}};
    }
  `);
  await writeJson(join(root, '.local/channel.json'), { enabled: true, id: 'fixture', slot, version: '1.0.0' });
  const service = await startServer({
    network, hold: true, startChannel: async host => {
      await assert.rejects(access(join(root, '.local/server.json')), {code: 'ENOENT'});
      return startConfiguredChannel(host, 'fixture');
    },
  });
  try {
    for (const id of Object.keys(instance.agents)) {
      const guide = await readJson(join(network.catalog.get(id).workspace, 'TEAM-CURRENT.json'));
      assert.equal(guide.channel, 'fixture');
      assert.ok(guide.features.includes('review-channel'));
    }
    assert.equal((await readJson(join(root, '.local/server.json'))).pid, process.pid);
  } finally { await service.close(); }
});
