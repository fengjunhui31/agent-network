import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './network-fixture.mjs';
import { Catalog } from '../src/catalog.mjs';
import { writeJson, readJson } from '../src/paths.mjs';
import { assistantSettings } from '../src/assistant-settings.mjs';
import { codexModels } from '../src/codex-discovery.mjs';

async function configure(root, patch) {
  const path = join(root, 'network.json'), config = await readJson(path);
  Object.assign(config.agents.a, { manager: true, runtime: 'claude', model: 'm1', ...patch });
  config.coordinatorId = 'a';
  config.models = { m1: { runtimes: ['claude'] }, m2: { runtimes: ['dsh'] } };
  await writeJson(path, config);
}

test('personal work style follows the primary identity while the project retains its own instructions', async t => {
  const { root } = await fixture(t), project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'AGENTS.md'), 'project rules');
  await configure(root, { workspace: project, instructions: 'My personal name' });
  // Fresh installation, so the configured project owns this employee from its first session.
  await writeJson(join(root, '.local/agents.json'), {});
  const catalog = await Catalog.load(root), primary = catalog.get('a');
  const prompt = await catalog.prepare(primary);
  assert.match(prompt, /My personal name/); assert.match(prompt, /个人助手工作模板/);
  assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), 'project rules');
  assert.match(await readFile(join(primary.configDirectory, 'CLAUDE.md'), 'utf8'), /个人助手工作模板/);
  assert.doesNotMatch(await catalog.prepare(catalog.get('b')), /个人助手工作模板/);
  await configure(root, { workspace: project, workProfile: null });
  await catalog.refresh();assert.doesNotMatch(await catalog.prepare(catalog.get('a')), /个人助手工作模板/);
});

test('a plain answer has no attachments; named files support spaces and old whole-project listings are filtered', async t => {
  const { network, controls, root } = await fixture(t);
  async function run(answer) {
    const ready = once(network, 'event'), r = await network.delegate({ target:'a', message:'task' }); await ready;
    controls.get('a').finish({ answer, stopReason:'end_turn' });
    return network.getResult(r.runId, 1000);
  }
  const dir = network.catalog.get('a').workspace, file = join(dir,'my note.txt'), other = join(dir,'my note.txt.bak');
  await writeFile(file,'note');await writeFile(other,'private');
  assert.deepEqual((await run('你好')).outputFiles, []);
  assert.deepEqual((await run('Read '+other)).outputFiles.map(x=>x.path), [other]);
  assert.deepEqual((await run('Here '+file+'。')).outputFiles.map(x=>x.path), [file]);
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await writeJson(join(root,'.local/runs',id+'.json'),{runId:id, answer:'done', outputFiles:[{path:file,size:4}],status:'completed'});
  assert.deepEqual((await network.getResult(id)).outputFiles, []);
});

test('the bound coordinator changes its next runtime and model without modifying the in-flight run', async t => {
  const { network, controls, root } = await fixture(t);
  await configure(root,{});await network.catalog.refresh();
  const bin=join(root,'.local/runtimes/dsh/initial/node_modules/.bin/dsh');
  await mkdir(join(bin,'..'),{recursive:true});await writeFile(bin,'stub');await chmod(bin,0o700);
  const ready=once(network,'event');const handle=await network.delegate({target:'a',from:'user',message:'switch'});await ready;
  const base={from:'a'};
  const changed=await assistantSettings(network,{...base,operation:'set',runtime:'dsh',model:'m2'});
  assert.deepEqual(changed.running,{runtime:'claude',model:'m1'});assert.equal(changed.configured.runtime,'dsh');assert.equal(changed.appliesTo,'next-run');
  assert.equal(network.runs.get(handle.runId).runtime,'claude');
  assert.equal((await readJson(join(root,'network.json'))).agents.a.model,'m2');
  await assert.rejects(assistantSettings(network,{...base,operation:'set',runtime:'dsh',model:'m1'}),/disabled/);
  controls.get('a').finish({answer:'ready',stopReason:'end_turn'});await network.getResult(handle.runId,1000);
  const next=once(network,'event');const notice=await network.send({to:'a',from:'b',message:'ping'});await next;
  assert.match(controls.get('a').lastMessage,/独立通知/);
  await assert.rejects(assistantSettings(network,{...base,operation:'set',runtime:'claude',model:'m1'}),/bound owner/);
  controls.get('a').finish({answer:'ok',stopReason:'end_turn'});assert.equal((await network.getResult(notice.wakeRunId,1000)).runtime,'dsh');
});

test('Codex model discovery reads visible models across pages without starting a session', async () => {
  const calls=[];
  const client={call:async(method,args)=>{calls.push(method);return args.cursor
    ? {data:[{id:'new'},{id:'hidden',hidden:true},{id:'first'}]}
    : {data:[{model:'first'}],nextCursor:'next'};}};
  assert.deepEqual(await codexModels('.',client),['first','new']);
  assert.deepEqual(calls,['model/list','model/list']);
});
