import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentNetwork } from '../src/network.mjs';
import { startServer } from '../src/server.mjs';
import { identity } from '../src/federation-identity.mjs';
import { claim } from '../src/host-enroll.mjs';
import { ROOT, writeJson, readJson } from '../src/paths.mjs';
const exec = promisify(execFile),
  dir = await mkdtemp(join(tmpdir(), 'owned-host-')),
  relayFile = join(dir, 'relay.json'),
  cli = join(ROOT, 'packages/relay/cli.mjs');
const call = (...args) => exec(process.execPath, [cli, ...args, '--config', relayFile], { timeout: 15000 });
const until = async (check, label, ms = 70000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw Error('Timed out: ' + label);
};
let relay;
const services = [];
try {
  const relayCard = JSON.parse((await call('init', '--listen', '/ip4/127.0.0.1/tcp/0')).stdout);
  const homes = ['primary', 'new', 'other'].map((n) => join(dir, n)),
    keys = [];
  for (const home of homes) {
    await mkdir(home);
    keys.push(await identity(join(home, '.local/federation/identity.json')));
  }
  await call('allow', keys[0].card.peerId);
  await call('sponsor', keys[0].card.peerId);
  relay = spawn(process.execPath, [cli, 'serve', '--config', relayFile], {
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const rs = await until(async () => {
    const r = await readJson(join(dir, 'relay-status.json'), null);
    return r?.state === 'ready' && r;
  }, 'relay');
  const relayCfg = { address: rs.addresses[0].split('/p2p/')[0], peerId: relayCard.peerId };
  for (const home of homes.slice(0, 2)) {
    await writeJson(join(home, 'network.json'), {
      workspaceRoot: '.local/workspaces',
      coordinatorId: 'lead',
      templates: { lead: { manager: true, runtime: 'test', capabilities: [] } },
      agents: { lead: { template: 'lead' } },
      federation: { enabled: true, routing: 'local-first', relay: relayCfg }
    });
    const network = await AgentNetwork.create({ root: home });
    services.push(await startServer({ network }));
  }
  const A = services[0].network.federation,
    B = services[1].network.federation;
  const inv = await A.hosts.issue('lab');
  await assert.rejects(B.hosts.register(inv, false, {}), /consent/);
  await B.hosts.register(inv, true, {});
  const pending = await until(async () => {
    const r = await A.hosts.pending();
    return r.find((x) => x.id === inv.id && x.state === 'pending');
  }, 'claim');
  assert.deepEqual(pending.card, B.card);
  await assert.rejects(claim(inv, keys[2].card, keys[2].key), /bound/);
  await assert.rejects(claim(inv, keys[2].card, keys[1].key), /Invalid/);
  assert.equal((await A.hosts.list()).length, 0);
  await A.hosts.decide(inv.id, true);
  const row = await until(async () => (await A.hosts.list()).find((x) => x.revision >= 1), 'first report');
  assert.equal(row.alias, 'lab');
  assert.equal(row.hostId, B.card.networkId);
  assert.ok(row.contextId);
  assert.ok(row.cli.includes('node'));
  assert.equal((await A.hosts.list('node')).length, 1);
  await assert.rejects(A.hosts.callHost('lab', 'lark.document.read', 'secret'), /not authorized/);
  await assert.rejects(A.hosts.callHost('lab', 'lark.message.send', 'any'), /not authorized/);
  const version = await A.hosts.callHost('lab', 'cli.version', 'node');
  assert.equal(version.resource, 'node');
  assert.ok(version.version);
  assert.ok((await A.hosts.callHost('lab', 'inventory.refresh')).scheduled);
  await until(async () => (await A.hosts.detail('lab')).revision > row.revision, 'new revision');
  const state = await B.hosts.store.read();
  assert.equal(state.local.member.state, 'approved');
  assert.equal(state.local.member.invitation, undefined);
  assert.equal((await B.hosts.register(inv, true, {})).registration.state, 'approved');
  await A.hosts.decide(inv.id, false);
  assert.equal((await A.hosts.list()).length, 0);
  await assert.rejects(A.hosts.callHost('lab', 'cli.version', 'node'));
  console.log(
    JSON.stringify({
      approvedOnce: true,
      bootstrapIsBound: true,
      hostReportReceived: true,
      revisionAdvanced: true,
      disallowedFeishuActionsRejected: true,
      revoked: true
    })
  );
} finally {
  for (const s of services.reverse()) await s.close();
  if (relay?.exitCode === null) {
    relay.kill('SIGTERM');
    await Promise.race([new Promise((r) => relay.once('exit', r)), sleep(2500)]);
  }
  await rm(dir, { recursive: true, force: true });
}
