import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { OwnedHosts } from './owned-hosts.mjs';
import { identity, validPeer } from './federation-identity.mjs';
import { FederationTransport } from './federation-transport.mjs';
import { FederationStore, ReturnStore } from './federation-store.mjs';
import { readJson } from './portable-io.mjs';

const id = z.string().uuid(),
  peer = z
    .string()
    .max(100)
    .refine((v) => {
      try {
        return validPeer(v) === v;
      } catch {
        return false;
      }
    });
const alias = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  text = z.string().trim().min(1).max(6000);
const cardSpec = z.object({ networkId: id, peerId: peer }).strict();
const inviteSpec = z
  .object({
    version: z.literal(1),
    id: id,
    issuer: cardSpec,
    audience: cardSpec,
    relayPeerId: peer,
    expires: z.number().finite(),
    preapproved: z.boolean()
  })
  .strict();
const formSpec = z
  .object({ inviteId: id, name: z.string().trim().min(1).max(100), offeredId: alias, returnAlias: alias })
  .strict();
const msgSpec = z
  .object({ text, ticket: id.optional(), replyTo: id.optional() })
  .strict()
  .refine((m) => !(m.ticket && m.replyTo), 'Choose a request or reply');
const active = (s) => ['approved', 'pending'].includes(s);
const visible = (l) => ({
  mode: 'network',
  transport: 'federation',
  id: l.id,
  address: 'node:' + l.id,
  networkId: l.networkId,
  peerId: l.peerId,
  name: l.name,
  linkId: l.linkId,
  direction: l.direction,
  status: l.status
});
function sameCard(a, b) {
  return a.networkId === b.networkId && a.peerId === b.peerId;
}
function matchLink(links, from, key, linkId) {
  const l = links[from];
  if (!l || l.peerId !== key || l.linkId !== linkId)
    throw new Error('Unknown contact identity or generation');
  return l;
}
function available(links, networkId, localAlias) {
  if (!links[networkId] && Object.keys(links).length >= 512) throw new Error('Contact directory is full');
  if (Object.values(links).some((l) => l.networkId !== networkId && active(l.status) && l.id === localAlias))
    throw new Error('Contact alias is already used');
}
export class Federation {
  static async open(network, networkId, config) {
    const credentials = await identity(join(network.root, '.local/federation/identity.json'), networkId);
    const f = new Federation(network, credentials.card, config);
    await f.transport.start(credentials.key);
    try { f.hosts=new OwnedHosts(f,credentials.key); await f.hosts.start(); } catch(error) { await f.close(); throw error; }
    return f;
  }
  constructor(network, card, config) {
    if (config.routing && config.routing !== 'local-first')
      throw new Error('Unsupported federation routing policy');
    if (config.peerTaskPolicy?.crossNetworkFiles) throw new Error('Federation supports text only');
    this.network = network;
    this.card = card;
    this.config = config;
    this.store = new FederationStore(network.root);
    this.returns = new ReturnStore(network.root);
    this.transport = new FederationTransport(card, config.relay, (key, frame, route) =>
      this.receive(key, frame, route)
    );
    this.deliveries = new Map();
    this.work = new Set();
    this.perContact = new Map();
    this.routing = new Map();
    this.onSettled = () => {
      if (!this.closing)
        void this.recover().catch((e) => {
          this.lastRecoveryError = e.message;
        });
    };
    network.on('settled', this.onSettled);
  }
  async list() {
    return Object.values((await this.store.read()).contacts)
      .filter((l) => active(l.status))
      .map(visible);
  }
  async find(a) {
    alias.parse(a);
    const all = Object.values((await this.store.read()).contacts).filter((l) => l.id === a);
    return all.find((l) => active(l.status)) ?? all.at(-1);
  }
  async legacyClear(remote, localAlias) {
    const links = Object.values((await this.network.peers.read()).links);
    if (links.some((l) => active(l.status) && (l.networkId === remote || l.id === localAlias)))
      throw new Error('Leave or revoke the existing legacy relationship on both endpoints first');
  }
  async invite(to, preapproved = false) {
    const audience = cardSpec.parse(to);
    if (audience.networkId === this.card.networkId || audience.peerId === this.card.peerId)
      throw new Error('Choose a different network');
    const invite = {
      version: 1,
      id: randomUUID(),
      issuer: this.card,
      audience,
      relayPeerId: this.transport.relayPeer,
      expires: Date.now() + 86400000,
      preapproved
    };
    await this.store.edit((s) => {
      for (const [k, v] of Object.entries(s.invites)) if (v.expires <= Date.now()) delete s.invites[k];
      if (Object.keys(s.invites).length >= 512) throw new Error('Invitation limit reached');
      s.invites[invite.id] = invite;
    });
    return invite;
  }
  async join(form) {
    if (form.consent !== true) throw new Error('Explicit consent is required');
    const inv = inviteSpec.parse(form.invitation);
    if (
      !sameCard(inv.audience, this.card) ||
      inv.issuer.networkId === this.card.networkId ||
      inv.issuer.peerId === this.card.peerId ||
      inv.relayPeerId !== this.transport.relayPeer ||
      inv.expires <= Date.now()
    )
      throw new Error('Invitation is expired or for another identity or relay');
    const data = formSpec.parse({
      inviteId: inv.id,
      name: form.name,
      offeredId: form.id,
      returnAlias: form.remoteAlias
    });
    await this.legacyClear(inv.issuer.networkId, form.remoteAlias);
    const l = await this.store.edit((s) => {
      const old = s.contacts[inv.issuer.networkId];
      available(s.contacts, inv.issuer.networkId, form.remoteAlias);
      if (old && active(old.status)) {
        if (
          old.peerId !== inv.issuer.peerId ||
          old.inviteId !== inv.id ||
          old.id !== form.remoteAlias ||
          old.remoteAlias !== form.id
        )
          throw new Error('Existing relationship differs; leave it before joining again');
        return old;
      }
      const l = {
        ...inv.issuer,
        id: form.remoteAlias,
        remoteAlias: form.id,
        name: form.remoteAlias,
        linkId: randomUUID(),
        inviteId: inv.id,
        direction: 'outgoing',
        status: 'pending'
      };
      s.contacts[l.networkId] = l;
      return l;
    });
    const remote = await this.call(l, 'apply', data);
    return this.observe(l, remote.status);
  }
  call(l, action, data = {}, messageId = randomUUID()) {
    return this.transport.call(l, { action, data, linkId: l.linkId, messageId });
  }
  async observe(l, status) {
    if (!['pending', 'approved', 'left', 'rejected', 'revoked'].includes(status))
      throw new Error('Invalid remote state');
    const result=await this.store.edit((s) => {
      const cur = matchLink(s.contacts, l.networkId, l.peerId, l.linkId);
      if (active(cur.status) && (!active(status) || (cur.direction === 'outgoing' && status === 'approved')))
        cur.status = status;
      return visible(cur);
    });
    if(!active(result.status))await this.hosts?.linkClosed(l);
    return result;
  }
  async receive(key, f, route) {
    id.parse(f.from);
    id.parse(f.linkId);
    id.parse(f.messageId);
    if (f.action === 'apply') return this.receiveApply(key, f);
    const l = matchLink((await this.store.read()).contacts, f.from, key, f.linkId);
    if (f.action === 'status')
      return { status: l.status, direction: l.direction, offeredId: l.remoteAlias, returnAlias: l.id };
    const hostAction = ['host.part', 'host.invoke'].includes(f.action);
    if (!hostAction && !['notice', 'message'].includes(f.action)) throw new Error('Unknown federation action');
    if ((hostAction || f.action === 'message') && !active(l.status)) throw new Error('Contact revoked or closed');
    const remote = await this.call(l, 'status');
    if (f.action === 'notice') return { status: (await this.observe(l, remote.status)).status };
    const current = matchLink((await this.store.read()).contacts, f.from, key, f.linkId);
    if (
      !active(current.status) ||
      !active(remote.status) ||
      current.direction === remote.direction ||
      (current.direction === 'incoming' ? current.status : remote.status) !== 'approved'
    )
      throw new Error('Contact is not approved');
    if (hostAction) {
      if (this.network.gate.phase !== 'open') throw new Error('busy_draining');
      return this.hosts.receive(current,f);
    }
    const msg = msgSpec.parse(f.data);
    const event = {
      ...msg,
      messageId: f.messageId,
      linkId: l.linkId,
      networkId: l.networkId,
      peerId: l.peerId,
      alias: l.id,
      route
    };
    const k = l.linkId + '/' + f.messageId,
      payload = JSON.stringify(msg),
      entry = this.deliveries.get(k);
    if (entry) {
      if (entry.payload !== payload) throw new Error('Message ID conflict');
      return entry.promise;
    }
    for (const [i, d] of this.deliveries) if (d.done && d.at < Date.now() - 600000) this.deliveries.delete(i);
    if (this.deliveries.size >= 4096) throw new Error('Peer delivery capacity exceeded');
    const d = { payload, at: Date.now(), done: false };
    d.promise = this.deliver(event).finally(() => {
      d.done = true;
    });
    this.deliveries.set(k, d);
    try {
      return await d.promise;
    } catch (e) {
      this.deliveries.delete(k);
      throw e;
    }
  }
  async receiveApply(key, f) {
    const data = formSpec.parse(f.data),
      peerCard = { networkId: f.from, peerId: key };
    const validate = (s) => {
      const old = s.contacts[f.from],
        inv = s.invites[data.inviteId];
      if (
        old?.linkId === f.linkId &&
        old.peerId === key &&
        old.inviteId === data.inviteId &&
        old.direction === 'incoming' &&
        old.id === data.offeredId &&
        old.remoteAlias === data.returnAlias
      )
        return { old };
      if (!inv || inv.used || inv.expires <= Date.now() || !sameCard(inv.audience, peerCard))
        throw new Error('Invitation does not authorize this identity');
      if (
        old &&
        active(old.status) &&
        (old.direction !== 'outgoing' || old.status !== 'pending' || this.card.networkId < f.from)
      )
        throw new Error('Existing contact generation is active');
      available(s.contacts, f.from, data.offeredId);
      return { inv };
    };
    const previous = validate(await this.store.read());
    if (previous.old) return { status: previous.old.status };
    await this.legacyClear(f.from, data.offeredId);
    const remote = await this.call({ ...peerCard, linkId: f.linkId }, 'status');
    if (
      remote.direction !== 'outgoing' ||
      !active(remote.status) ||
      remote.offeredId !== data.offeredId ||
      remote.returnAlias !== data.returnAlias
    )
      throw new Error('Applicant did not confirm this relationship');
    return this.store.edit((s) => {
      const { inv, old } = validate(s);
      if (old) return { status: old.status };
      inv.used = true;
      const status = inv.preapproved ? 'approved' : 'pending';
      s.contacts[f.from] = {
        ...peerCard,
        id: data.offeredId,
        remoteAlias: data.returnAlias,
        name: data.name,
        linkId: f.linkId,
        inviteId: inv.id,
        direction: 'incoming',
        status
      };
      return { status };
    });
  }
  async decide(l, action) {
    const status = { approve: 'approved', reject: 'rejected', leave: 'left', revoke: 'revoked' }[action];
    const cur = await this.store.edit((s) => {
      const c = matchLink(s.contacts, l.networkId, l.peerId, l.linkId);
      if (!status || (action !== 'leave' && c.direction !== 'incoming'))
        throw new Error('Invalid membership decision');
      if (
        c.status !== status &&
        ((['approve', 'reject'].includes(action) && c.status !== 'pending') ||
          (action === 'revoke' && c.status !== 'approved') ||
          !active(c.status))
      )
        throw new Error('Invalid contact state');
      c.status = status;
      return c;
    });
    if(!active(cur.status))await this.hosts?.linkClosed(cur);
    let notified = true;
    try {
      await this.call(cur, 'notice');
    } catch {
      notified = false;
    }
    return { ...visible(cur), peerNotified: notified };
  }
  async transmit(l, body, run, replyTo, messageId = randomUUID()) {
    const msg = text.parse(body);
    id.parse(messageId);
    if (!active(l.status) || (l.direction === 'incoming' && l.status !== 'approved'))
      throw new Error('Communication node is not approved');
    const session = this.network.peerSession(run);
    if (session) {
      if (!session.startsWith('peer:' + l.networkId + ':' + l.linkId + ':'))
        throw new Error('A peer turn can reply only to the originating contact');
      replyTo ??= session.split(':')[3];
    }
    const ticket = run && !replyTo ? (await this.returns.ticket(l, run)).id : undefined;
    const result = await this.call(
      l,
      'message',
      { text: msg, ...(ticket ? { ticket } : {}), ...(replyTo && replyTo !== 'general' ? { replyTo } : {}) },
      messageId
    );
    return {
      accepted: result.accepted === true,
      address: 'node:' + l.id,
      messageId,
      ...(ticket ? { ticket } : {}),
      route: this.transport.lastRoutes.get(l.networkId)?.route
    };
  }
  async deliver(event) {
    if (this.network.gate.phase !== 'open' && !event.replyTo) throw new Error('busy_draining');
    if (event.replyTo) {
      const state = await this.returns.read(),
        t = state.tickets[event.replyTo];
      if (t && t.linkId === event.linkId && t.remotePeerId === event.peerId && t.expires > Date.now()) {
        const saved = await this.returns.put('received', event);
        await this.routeReturn(t, saved.event);
        return { accepted: true };
      }
    }
    const startWorker = Boolean(event.ticket && this.config.peerTaskPolicy?.allowedTemplates?.length);
    if (startWorker && (this.work.size >= 4 || (this.perContact.get(event.linkId) ?? 0) >= 2))
      throw new Error('busy: external text worker limit reached');
    if (startWorker) this.perContact.set(event.linkId, (this.perContact.get(event.linkId) ?? 0) + 1);
    const release = () => {
      const n = (this.perContact.get(event.linkId) ?? 1) - 1;
      if (n) this.perContact.set(event.linkId, n);
      else this.perContact.delete(event.linkId);
    };
    try {
      const saved = await this.returns.put('incoming', event);
      if (startWorker && saved.created) {
        const work = this.textWorker(event)
          .catch((e) => this.mark(event, 'incoming', { workerError: e.message }))
          .finally(() => {
            this.work.delete(work);
            release();
          });
        this.work.add(work);
      } else if (startWorker) release();
    } catch (error) {
      if (startWorker) release();
      throw error;
    }
    return { accepted: true };
  }
  mark(e, collection, fields) {
    return this.returns.edit((s) => Object.assign(s[collection][e.messageId], fields));
  }
  async textWorker(event) {
    const templateId = this.config.peerTaskPolicy.allowedTemplates[0],
      spec = this.network.catalog.config.templates[templateId];
    if (!spec || spec.manager)
      throw new Error('External text worker requires an allowed non-manager template');
    const { NEW_API_URL, NEW_API_KEY } = await readJson(
      join(this.network.root, '.local/credentials.json'),
      {}
    );
    if (!NEW_API_URL || !NEW_API_KEY) throw new Error('No local text-only model gateway configured');
    const url = new URL(NEW_API_URL.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/v1/chat/completions');
    const l = await this.find(event.alias);
    if (l.linkId !== event.linkId) throw new Error('Contact generation changed');
    await this.transmit(l, '已收到，正在处理。', null, event.ticket);
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + NEW_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: spec.model,
        messages: [
          { role: 'system', content: spec.instructions ?? 'Answer using only the supplied text.' },
          { role: 'user', content: event.text }
        ],
        max_tokens: 1024
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!res.ok) throw new Error('Local text model returned HTTP ' + res.status);
    const answer = (await res.json()).choices?.[0]?.message?.content;
    const current = await this.find(event.alias);
    if (current.linkId !== event.linkId) throw new Error('Contact generation changed');
    await this.transmit(current, text.parse(answer), null, event.ticket);
    await this.mark(event, 'incoming', { handled: true });
  }
  async routeReturn(ticket, event) {
    if (this.routing.has(event.messageId)) return this.routing.get(event.messageId);
    const task = this.routeOnce(ticket, event).finally(() => this.routing.delete(event.messageId));
    this.routing.set(event.messageId, task);
    return task;
  }
  async routeOnce(ticket, event) {
    if (event.routed || this.closing) return;
    const active = this.network.activeRun(ticket.agentId, ticket.sessionKey ?? undefined);
    if (active?.runId === ticket.runId && !event.notified) {
      const notice =
        '联系人 node:' +
        event.alias +
        ' 已向本轮返回文字，消息编号 ' +
        event.messageId +
        '。完整外部结果由受限验收轮交回原会话。';
      try {
        await this.network.send({
          to: ticket.agentId,
          from: 'node:' + event.alias,
          expectedRunId: active.runId,
          messageId: event.messageId,
          message: notice
        });
        await this.mark(event, 'received', { notified: true, activeRunId: active.runId });
      } catch (e) {
        if (this.network.activeRun(ticket.agentId, ticket.sessionKey ?? undefined)?.runId === active.runId)
          throw e;
      }
    }
    if (ticket.originMessageId) {
      if (!this.network.gate.channel?.peerReturn) return;
      const queued = await this.network.gate.channel.peerReturn(ticket, event);
      if (!queued) return;
      await this.mark(event, 'received', {
        routed: true,
        originRunId: ticket.runId,
        originSessionKey: ticket.sessionKey,
        channelDelivery: queued
      });
      return;
    }
    if (
      this.network.gate.phase !== 'open' ||
      this.network.activeRun(ticket.agentId, ticket.sessionKey ?? undefined)
    )
      return;
    const run = await this.network.delegate({
      target: ticket.agentId,
      sessionKey: ticket.sessionKey ?? undefined,
      from: 'network:peer-return',
      continuationOfRunId: ticket.runId,
      originRunId: ticket.runId,
      peerReturn: event.messageId,
      message: '核对外部节点返回的公开文字'
    });
    await this.network.runs.get(run.runId).settled;
    await this.mark(event, 'received', {
      routed: true,
      originRunId: ticket.runId,
      originSessionKey: ticket.sessionKey,
      continuationRunId: run.runId
    });
  }
  async review(messageId, run) {
    const s = await this.returns.read(),
      event = s.received[id.parse(messageId)],
      ticket = event && s.tickets[event.replyTo];
    const l = event && (await this.find(event.alias));
    if (
      !ticket ||
      !l ||
      l.status !== 'approved' ||
      l.linkId !== event.linkId ||
      l.peerId !== event.peerId ||
      ticket.expires <= Date.now() ||
      ticket.runId !== run.continuationOfRunId ||
      ticket.agentId !== run.agentId ||
      ticket.originMessageId !== (run.originMessageId ?? null) ||
      (ticket.sessionKey ?? null) !== (run.sessionKey ?? null)
    )
      throw new Error('Peer result no longer belongs to this origin');
    // This locally rendered continuation has no native runtime, shell, model key or tools.
    return (
      '来自 node:' +
      l.id +
      ' 的回复：\n' +
      event.text.replace(/@/g, '＠').replace(/</g, '＜').replace(/>/g, '＞')
    );
  }
  async recover() {
    const s = await this.returns.read();
    for (const event of Object.values(s.received))
      if (!event.routed) {
        const t = s.tickets[event.replyTo],
          l = await this.find(event.alias);
        if (t && t.expires > Date.now() && l?.status === 'approved' && l.linkId === event.linkId)
          await this.routeReturn(t, event);
      }
  }
  async manage(p) {
    if (p.action === 'identity') return this.card;
    if (p.action === 'relay-status') return this.transport.status();
    if (p.action === 'invite') return this.invite(p.card, p.preapprove);
    if (p.action === 'join') return this.join(p);
    const l = await this.find(p.id);
    if (!l) throw new Error('Unknown federation contact');
    if (p.action === 'status') {
      try {
        const remote = await this.call(l, 'status');
        return {
          ...(await this.observe(l, remote.status)),
          contacted: true,
          route: this.transport.lastRoutes.get(l.networkId)
        };
      } catch (e) {
        return { ...visible(l), contacted: false, detail: e.message };
      }
    }
    if (p.action === 'send') return this.transmit(l, p.message, undefined, undefined, p.messageId);
    if (p.action === 'inbox' || p.action === 'returns') {
      const s = await this.returns.read();
      return Object.values(p.action === 'inbox' ? s.incoming : s.received).filter(
        (e) => e.linkId === l.linkId
      );
    }
    if (p.action === 'reply') {
      const e = (await this.returns.read()).incoming[id.parse(p.requestId)];
      if (!e || e.linkId !== l.linkId || !e.ticket) throw new Error('No matching request ticket');
      return this.transmit(l, p.message, null, e.ticket, p.messageId);
    }
    return this.decide(l, p.action);
  }
  async close() {
    this.closing = true;
    this.network.off('settled', this.onSettled);
    await Promise.allSettled([...this.work, ...this.routing.values()]);
    await this.hosts?.close();
    await this.transport.close();
    await this.store.writes;
    await this.returns.writes;
  }
}
