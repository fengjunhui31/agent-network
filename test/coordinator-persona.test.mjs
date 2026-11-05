import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './network-fixture.mjs';
import { Catalog } from '../src/catalog.mjs';
import { readJson, writeJson } from '../src/paths.mjs';
import { assistantSettings } from '../src/assistant-settings.mjs';
import { teamStatus } from '../src/team-context.mjs';

async function prepare(t) {
  const f = await fixture(t), config = await readJson(join(f.root, 'network.json'));
  config.agents.a = { ...config.agents.a, manager:true, name:'Legacy', instructions:'Legacy biography' };
  config.coordinatorId = 'a';
  await writeJson(join(f.root, 'network.json'), config);
  await f.network.catalog.refresh();
  return f;
}
const fields = { name:'Elm', alias:'E', role:'Personal assistant', collaboration:'Assignees own their work',
  voice:'Quiet humor', privacy:'Private owner boundary', memory:'Record confirmed decisions' };

test('the primary gets one effective identity in fresh prompts and the directory; staff see only the public role', async t => {
  const { root,network } = await prepare(t);let c = network.catalog;
  assert.match(await c.prepare(c.get('a')), /Legacy biography/);
  await c.updateCoordinatorPersona('a', fields);
  const path = join(root,'.local/personas/a.json');assert.equal((await stat(path)).mode & 0o077,0);
  const config=await readJson(join(root,'network.json'));config.agents.a.runtime='dsh';await writeJson(join(root,'network.json'),config);
  c=await Catalog.load(root);
  const p=await c.prepare(c.get('a'));assert.match(p,/Elm/);assert.match(p,/Assignees own their work/);assert.match(p,/个人助手工作模板/);assert.doesNotMatch(p,/Legacy biography/);
  const dir=c.get('a').workspace;
  for(const f of ['AGENTS.md','CLAUDE.md']) assert.equal(await readFile(join(dir,f),'utf8'),p);
  assert.equal(c.get('a').name,'Elm');assert.equal(c.get('a').runtime,'dsh');
  assert.doesNotMatch(await c.prepare(c.get('b')),/Quiet humor|Private owner boundary/);
  assert.doesNotMatch(JSON.stringify(await teamStatus(c,undefined,false)),/Quiet humor|Private owner boundary|Record confirmed decisions/);
  assert.equal(c.list().agents.find(a=>a.id==='a').instructions,'Personal assistant');
});

test('an owner can update separate fields concurrently and invalid updates leave the last persona intact', async t => {
  const { network,root } = await prepare(t);const c=network.catalog;
  await assert.rejects(c.updateCoordinatorPersona('b',fields),/primary coordinator/);
  await assert.rejects(c.updateCoordinatorPersona('a',{name:'Only a name'}),/name and a role/);
  await c.updateCoordinatorPersona('a',fields);
  await Promise.all([c.updateCoordinatorPersona('a',{name:'Elm Two'}),c.updateCoordinatorPersona('a',{memory:'New preference'})]);
  const expected={ ...fields,name:'Elm Two',memory:'New preference' };
  await assert.rejects(c.updateCoordinatorPersona('a',{name:' '}));
  await assert.rejects(c.updateCoordinatorPersona('a',{runtime:'codex'}));
  assert.deepEqual(await readJson(join(root,'.local/personas/a.json')),expected);
  await assert.rejects(c.update('a',{instructions:'old identity'}),/persona settings/);
});

test('an active bound owner can save a persona; a group task cannot read or replace the private fields', async t => {
  const { network,controls }=await prepare(t);
  const go=async from=>{const ready=once(network,'event');const h=await network.delegate({from,target:'a',message:'hello'});await ready;return h};
  network.gate.channel={ownsRun:r=>r.from==='wecom:owner'};
  const op={from:'a',operation:'persona'},owner=await go('wecom:owner');
  assert.deepEqual((await assistantSettings(network,{...op,fields})).profile,fields);
  assert.deepEqual((await assistantSettings(network,op)).profile,fields);
  controls.get('a').finish({answer:'ok',stopReason:'end_turn'});await network.getResult(owner.runId,1000);
  const group=await go('wecom:other');
  await assert.rejects(assistantSettings(network,{...op,fields:{name:'Wrong'}}),/bound owner/);
  await assert.rejects(assistantSettings(network,op),/bound owner/);
  controls.get('a').finish({answer:'ok',stopReason:'end_turn'});await network.getResult(group.runId,1000);
  assert.equal(network.catalog.get('a').name,'Elm');
});
