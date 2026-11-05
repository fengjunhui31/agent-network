// Three isolated identities, real Noise/Unix/Circuit Relay, no external accounts.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WecomBridge } from '../packages/wecom/src/wecom.mjs';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ROOT, writeJson, readJson } from '../src/paths.mjs';
import { AgentNetwork } from '../src/network.mjs';
import { startServer } from '../src/server.mjs';
import { identity } from '../src/federation-identity.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'fed-e2e-')),
  homes = ['a', 'b'].map((n) => join(directory, n));
const ends = [],
  cli = join(ROOT, 'packages/relay/cli.mjs'),
  config = join(directory, 'relay.json');
const runRelay = (...args) => exec(process.execPath, [cli, ...args, '--config', config], { timeout: 20000 });
const eventually = async (check) => {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const r = await check();
    if (r) return r;
    await delay(40);
  }
  throw Error('Federation acceptance timed out');
};
let child, bridge;
try {
  const rc = JSON.parse((await runRelay('init', '--listen', '/ip4/127.0.0.1/tcp/0')).stdout);
  const cards = [];
  for (const home of homes) {
    await mkdir(home);
    const entry = await identity(join(home, '.local/federation/identity.json'));
    cards.push(entry.card);
    await runRelay('allow', entry.card.peerId);
  }
  child = spawn(process.execPath, [cli, 'serve', '--config', config], {
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const relay = await eventually(async () => {
    const d = await readJson(join(directory, 'relay-status.json'), null);
    return d?.state === 'ready' && d;
  });
  const address = relay.addresses[0].split('/p2p/')[0];
  for (const [i, home] of homes.entries()) {
    await writeJson(join(home, 'network.json'), {
      workspaceRoot: 'workspaces',
      coordinatorId: 'lead',
      templates: { lead: { manager: true, runtime: 'test', capabilities: [] } },
      agents: { lead: { template: 'lead' } },
      federation: { enabled: true, routing: 'local-first', relay: { address, peerId: rc.peerId } }
    });
    const pending = new Map();
    const network = await AgentNetwork.create({
      root: home,
      runtimeFactory: (agent) => ({
        agent,
        async start() {},
        run() {
          return new Promise((done) =>
            pending.set(agent.sessionKey, (answer) => done({ answer, stopReason: 'end_turn' }))
          );
        },
        async cancel() {
          pending.get(agent.sessionKey)?.('closed');
        },
        stop() {
          pending.get(agent.sessionKey)?.('closed');
        }
      })
    });
    ends.push({ network, pending, service: await startServer({ network }) });
  }
  const [a, b] = ends,
    A = a.network.federation,
    B = b.network.federation;
  await eventually(() => A.transport.status().reserved && B.transport.status().reserved);
  const invitation = await B.invite(A.card);
  assert.equal(
    (await A.join({ invitation, id: 'mac', remoteAlias: 'team', name: 'Mac', consent: true })).status,
    'pending'
  );
  await assert.rejects(A.manage({ action: 'send', id: 'team', message: 'premature' }));
  await B.manage({ action: 'approve', id: 'mac' });
  const parent = await a.network.delegate({ target: 'lead', sessionKey: 'origin-one', message: 'test' });
  await eventually(() => a.pending.has('origin-one'));
  const token = [...a.network.runCredentials.entries()].find(([, actor]) => actor.runId === parent.runId)[0];
  const scoped = (method, body = {}) =>
    fetch(a.service.endpoint.url + method, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  assert.equal((await scoped('/maintenance', { action: 'status' })).status, 403);
  assert.equal((await scoped('/channel/owner', { action: 'request' })).status, 403);
  await assert.rejects(
    A.transport.call(
      { ...B.card, peerId: A.card.peerId },
      { action: 'status', linkId: randomUUID(), messageId: randomUUID() }
    ),
    /identity_mismatch/
  );
  const request = await a.network.send({
    to: 'node:team',
    from: 'lead',
    fromSessionKey: 'origin-one',
    message: 'Check one value'
  });
  assert.equal(request.route, 'local');
  const received = await B.manage({ action: 'inbox', id: 'mac' });
  assert.equal(received.length, 1);
  await B.manage({ action: 'reply', id: 'mac', requestId: received[0].messageId, message: 'Progress line' });
  assert.equal(a.network.receive('lead', 'PostToolUse', 'origin-one').messages.length, 1);
  a.pending.get('origin-one')('initial task ended');
  await a.network.runs.get(parent.runId).settled;
  assert.equal((await scoped('/inbox', { agent: 'lead' })).status, 401);
  await B.manage({ action: 'reply', id: 'mac', requestId: received[0].messageId, message: 'Final line' });
  const events = await eventually(async () => {
    const e = await A.manage({ action: 'returns', id: 'team' });
    return e.length === 2 && e.every((v) => v.routed) && e;
  });
  assert.ok(events.every((e) => e.originRunId === parent.runId && e.originSessionKey === 'origin-one'));
  assert.ok(events.some((e) => e.activeRunId === parent.runId));
  const completed = await a.network.getResult(events.find((e) => e.text === 'Final line').continuationRunId);
  assert.equal(completed.sessionKey, 'origin-one');
  assert.equal(completed.continuationOfRunId, parent.runId);
  assert.match(completed.answer, /Final line/);
  assert.equal(completed.runOrigin, 'peer-return');

  const receipts = [];
  class RecordingWeCom extends EventEmitter {
    connect() {
      this.emit('authenticated');
    }
    disconnect() {}
    async sendMessage(chatid, body) {
      receipts.push({ chatid, text: body.markdown.content });
      return { errcode: 0 };
    }
    async replyStream() {
      return { errcode: 0 };
    }
  }
  bridge = new WecomBridge(a.network, new RecordingWeCom(), {
    agentId: 'lead',
    allowedUserIds: ['owner'],
    enabledGroupIds: ['group-a', 'group-b']
  }).start();
  await bridge.ready;
  const groupRun = async (chatid) => {
    const inbound = randomUUID();
    await bridge.receive({
      body: {
        msgid: inbound,
        chattype: 'group',
        chatid,
        from: { userid: 'owner' },
        msgtype: 'text',
        text: { content: 'Please check this request' }
      }
    });
    return eventually(() => {
      const item = [...bridge.inbox.items.values()].find((i) => i.messageId === inbound);
      return item?.runId && a.pending.has(item.sessionKey) && a.network.runs.get(item.runId);
    });
  };
  const group = await groupRun('group-a'),
    other = await groupRun('group-b');
  const sent = await a.network.send({
    to: 'node:team',
    from: 'lead',
    fromSessionKey: group.sessionKey,
    message: 'Group work'
  });
  const eventId = randomUUID(),
    progress = {
      action: 'reply',
      id: 'mac',
      requestId: sent.messageId,
      message: 'Group work in progress',
      messageId: eventId
    };
  await B.manage(progress);
  await B.manage(progress);
  await assert.rejects(B.manage({ ...progress, message: 'conflicting body' }), /conflict/i);
  await eventually(() => receipts.some((x) => x.text.includes('Group work in progress')));
  assert.deepEqual(
    receipts.filter((x) => x.text.includes('Group work in progress')).map((x) => x.chatid),
    ['group-a']
  );
  const hooked = a.network.receive('lead', 'PostToolUse', group.sessionKey).messages;
  assert.equal(hooked.filter((n) => n.id === eventId).length, 1);
  assert.equal(
    a.network.receive('lead', 'PostToolUse', other.sessionKey).messages.filter((n) => n.id === eventId)
      .length,
    0
  );
  a.pending.get(group.sessionKey)('Parent finished');
  await group.settled;
  await B.manage({ action: 'reply', id: 'mac', requestId: sent.messageId, message: 'Late group result' });
  await eventually(() => receipts.some((x) => x.text.includes('Late group result')));
  const continuation = [...a.network.runs.values()].find(
    (r) => r.runOrigin === 'peer-return' && r.continuationOfRunId === group.runId
  );
  assert.equal(continuation.sessionKey, group.sessionKey);
  assert.equal(continuation.originMessageId, group.originMessageId);
  assert.deepEqual(
    receipts.filter((x) => x.text.includes('Late group result')).map((x) => x.chatid),
    ['group-a']
  );
  a.pending.get(other.sessionKey)('Finished other chat');
  await other.settled;
  await assert.rejects(bridge.ownerRequest({ groupId: 'disabled', key: 'qa', message: 'test' }));
  const owner = { groupId: 'group-a', key: 'qa-owner-key', message: 'local owner test' };
  const first = await bridge.ownerRequest(owner),
    repeat = await bridge.ownerRequest(owner);
  assert.equal(first.id, repeat.id);
  assert.equal(repeat.created, false);
  const post = await eventually(() => {
    const item = bridge.inbox.items.get(first.id),
      r = item?.runId && a.network.runs.get(item.runId);
    return r?.status === 'running' && a.pending.has(r.sessionKey) && r;
  });
  await a.network.replyUser({ from: 'lead', fromSessionKey: post.sessionKey, message: 'one owner post' });
  await a.network.replyUser({ from: 'lead', fromSessionKey: post.sessionKey, message: 'second copy' });
  a.pending.get(post.sessionKey)('internal final');
  await post.settled;
  await eventually(() => bridge.inbox.items.get(first.id).status === 'completed');
  assert.deepEqual(
    receipts.filter(
      (x) => x.text === 'one owner post' || x.text === 'second copy' || x.text === 'internal final'
    ),
    [{ chatid: 'group-a', text: 'one owner post' }]
  );
  await B.manage({ action: 'revoke', id: 'mac' });
  await assert.rejects(A.manage({ action: 'send', id: 'team', message: 'revoked' }));
  console.log(
    JSON.stringify({
      reserved: true,
      route: 'local',
      accepted: true,
      pendingDenied: true,
      revokedDenied: true,
      progressInActiveSession: true,
      lateResultInOriginSession: true,
      recordingWeCom: {
        activeOriginalGroup: true,
        lateOriginalGroup: true,
        distractorIsolated: true,
        idempotentOwnerPost: true
      }
    })
  );
} finally {
  if (bridge) {
    for (const f of ends[0].pending.values()) f('cleanup');
    await bridge.close();
  }
  for (const e of ends.reverse()) {
    for (const finish of e.pending.values()) finish('cleanup');
    await e.service.close();
  }
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((done) => child.once('exit', done)), delay(3500)]);
  }
  await rm(directory, { recursive: true, force: true });
}
