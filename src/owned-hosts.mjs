import { watch } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { voucher, claim, inviteSpec, alias } from './host-enroll.mjs';
import { uuid } from './host-wire.mjs';
import { HostStore, SnapshotReceiver, chunkSize, maxBytes, digest, publicRow } from './host-store.mjs';
import { inspectHost, invokeHost, localPolicy } from './host-inventory.mjs';

export class OwnedHosts {
  constructor(fed, key) {
    this.fed = fed;
    this.key = key;
    this.store = new HostStore(fed.network.root);
    this.receiver = new SnapshotReceiver(this.store);
    this.timer = null;
    this.watchers = [];
    this.rescan = true;
    this.delay = 1000;
    this.closing = false;
  }
  async start() {
    await this.store.edit(() => {});
    this.wake();
  }
  wake(ms = 0) {
    if (this.closing) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.busy) {
        this.again = true;
        return;
      }
      this.busy = this.cycle()
        .then(() => {
          this.delay = 1000;
          this.lastError = null;
        })
        .catch((e) => {
          this.lastError = e.message;
          this.wake(this.delay);
          this.delay = Math.min(this.delay * 2, 45000);
        })
        .finally(() => {
          this.busy = null;
          if (this.again) {
            this.again = false;
            this.wake();
          }
        });
    }, ms);
    this.timer.unref();
  }
  async issue(name) {
    alias.parse(name);
    await this.fed.legacyClear('', name);
    if (['approved', 'pending'].includes((await this.fed.find(name))?.status))
      throw new Error('Choose an unused host alias');
    const i = await voucher(this.fed.card, this.fed.config.relay, name);
    await this.store.edit((s) => {
      for (const [id, r] of Object.entries(s.issued))
        if ((r.state === 'revoked' && !r.relayPending) || (r.state === 'issued' && r.expires < Date.now()))
          delete s.issued[id];
      if (Object.values(s.issued).some((r) => r.alias === name) || Object.keys(s.issued).length >= 128)
        throw new Error('Host alias already used or directory full');
      s.issued[i.id] = { id: i.id, alias: name, expires: i.expires, state: 'issued' };
    });
    try {
      await this.fed.transport.relayAdmin({
        action: 'issue',
        id: i.id,
        bootstrap: i.bootstrap,
        expires: i.expires
      });
    } catch (e) {
      await this.store.edit((s) => {
        delete s.issued[i.id];
      });
      throw e;
    }
    return i;
  }
  async register(raw, consent, policy) {
    if (consent !== true) throw new Error('Joining requires local consent');
    const i = inviteSpec.parse(raw);
    if (
      i.expires <= Date.now() ||
      i.issuer.networkId === this.fed.card.networkId ||
      i.issuer.peerId === this.fed.card.peerId ||
      i.relay.address !== this.fed.config.relay.address ||
      i.relay.peerId !== this.fed.transport.relayPeer
    )
      throw new Error('Invitation expired, self-referential or for another relay');
    await this.store.edit((s) => {
      const m = s.local.member;
      if (m && m.id !== i.id && !['revoked', 'expired'].includes(m.state))
        throw new Error('This environment already belongs to a primary; leave it first');
      if (!m || m.id !== i.id) {
        s.local.policy = localPolicy.parse(policy ?? {});
        s.local.member = {
          id: i.id,
          issuer: i.issuer,
          alias: i.alias,
          expires: i.expires,
          state: 'pending',
          invitation: i
        };
        delete s.local.snapshot;
        s.local.dirty = false;
        s.local.revision = 0;
      }
    });
    this.wake();
    return this.localStatus();
  }
  async registration(m) {
    if (m.expires <= Date.now()) {
      await this.store.edit((s) => {
        if (s.local.member?.id === m.id) {
          s.local.member.state = 'expired';
          delete s.local.member.invitation;
        }
      });
      return;
    }
    const r = await claim(m.invitation, this.fed.card, this.key);
    if (r.state !== 'approved') {
      this.wake(2500);
      return;
    }
    if (r.admission.issuer.peerId !== m.issuer.peerId || r.admission.issuer.networkId !== m.issuer.networkId)
      throw new Error('Primary identity mismatch');
    const l = await this.fed.join({
      invitation: r.admission,
      id: m.alias,
      remoteAlias: 'primary',
      name: m.alias,
      consent: true
    });
    if (l.status !== 'approved') throw new Error('Waiting for authenticated membership approval');
    await this.store.edit((s) => {
      const current = s.local.member;
      if (current?.id !== m.id || current.state !== 'pending') throw new Error('Local enrollment changed');
      Object.assign(current, { state: 'approved', linkId: l.linkId });
      delete current.invitation;
    });
    this.rescan = true;
    this.again = true;
  }
  async decide(id, approve) {
    if (!uuid.test(id)) throw new Error('Invalid local invitation ID');
    const entry = (await this.store.read()).issued[id];
    if (!entry) throw new Error('Unknown local invitation');
    if (!approve) {
      // Persist the local deny before a best-effort notification or remote relay operation.
      await this.store.edit((s) => {
        s.issued[id].state = 'revoked';
        s.issued[id].relayPending = true;
        delete s.issued[id].report;
      });
      const l = await this.fed.find(entry.alias);
      if (l?.direction === 'incoming' && l.status === 'approved' && l.inviteId === entry.admission?.id)
        await this.fed.decide(l, 'revoke');
      this.receiver.staged.delete(id);
      this.wake();
      await this.finalizeRevoke(id);
      return { state: 'revoked' };
    }
    if (entry.state === 'revoked') throw new Error('Invitation revoked');
    const claim = await this.fed.transport.relayAdmin({ action: 'status', id });
    if (!claim.card || !['pending', 'approved'].includes(claim.state))
      throw new Error('No pending machine claim');
    const existing = await this.fed.find(entry.alias);
    if (
      existing &&
      ['approved', 'pending'].includes(existing.status) &&
      existing.inviteId !== entry.admission?.id
    )
      throw new Error('Host alias is in use by another contact');
    const admission = entry.admission ?? (await this.fed.invite(claim.card, true));
    const bound = await this.store.edit((s) => {
      const r = s.issued[id];
      if (r.state === 'revoked' || (r.card && r.card.peerId !== claim.card.peerId))
        throw new Error('Host approval changed');
      r.card = claim.card;
      if (r.state !== 'approved') r.state = 'approving';
      r.admission ??= admission;
      return r.admission;
    });
    try {
      await this.finalizeApproval(id, bound);
    } catch (error) {
      this.wake();
      throw error;
    }
    return { state: 'approved', id, alias: entry.alias, card: claim.card };
  }
  async finalizeApproval(id, admission) {
    await this.fed.transport.relayAdmin({ action: 'approve', id, admission });
    await this.store.edit((s) => {
      if (s.issued[id].state === 'revoked') throw new Error('Host approval revoked');
      s.issued[id].state = 'approved';
    });
  }
  async finalizeRevoke(id) {
    await this.fed.transport.relayAdmin({ action: 'revoke', id });
    await this.store.edit((s) => {
      if (s.issued[id]?.state === 'revoked') s.issued[id].relayPending = false;
    });
  }
  async linkClosed(link) {
    await this.store.edit((s) => {
      const record = Object.values(s.issued).find(
        (r) => r.admission?.id === link.inviteId && r.card.peerId === link.peerId
      );
      if (record && record.state !== 'revoked') {
        record.state = 'revoked';
        record.relayPending = true;
        delete record.report;
        this.receiver.staged.delete(record.id);
      }
      const m = s.local.member;
      if (m?.linkId === link.linkId) {
        m.state = 'revoked';
        s.local.dirty = false;
        delete m.invitation;
        this.unwatch();
      }
    });
    this.wake();
  }
  async pending() {
    const rows = Object.values((await this.store.read()).issued).filter(
      (r) => r.state === 'issued' && r.expires > Date.now()
    );
    const results = [];
    for (const r of rows) {
      const state = await this.fed.transport.relayAdmin({ action: 'status', id: r.id });
      results.push({ id: r.id, alias: r.alias, ...state });
    }
    return results;
  }
  async localStatus() {
    const s = (await this.store.read()).local,
      m = s.member;
    return {
      contextId: s.contextId,
      revision: s.revision,
      dirty: s.dirty,
      registration: m ? { id: m.id, issuer: m.issuer, alias: m.alias, state: m.state } : null,
      error: this.lastError ?? null
    };
  }
  async inspect() {
    const l = (await this.store.read()).local;
    return inspectHost(this.fed.network.root, l.contextId, l.policy);
  }
  async list(search) {
    const q = String(search ?? '').toLowerCase();
    return Object.values((await this.store.read()).issued)
      .filter((r) => r.state === 'approved')
      .filter((r) => {
        const s = r.report?.snapshot;
        return (
          !q ||
          [
            r.alias,
            ...(s?.runtimes ?? []).map((x) => x.type),
            ...(s?.cli ?? []).map((x) => x.name),
            ...(s?.capabilities ?? []).map((x) => x.name),
            ...(s?.grants ?? []).map((x) => x.action)
          ].some((v) => v.toLowerCase().includes(q))
        );
      })
      .map((r) => publicRow(r));
  }
  async detail(name) {
    const r = await this.approved(name);
    return publicRow(r, true);
  }
  async approved(name) {
    alias.parse(name);
    const r = Object.values((await this.store.read()).issued).find(
      (r) => r.alias === name && r.state === 'approved'
    );
    if (!r) throw new Error('Unknown approved host');
    return r;
  }
  async callHost(name, action, resource) {
    const r = await this.approved(name),
      l = await this.fed.find(name);
    if (!l || l.status !== 'approved' || l.peerId !== r.card.peerId || l.inviteId !== r.admission.id)
      throw new Error('No approved matching host link');
    return this.fed.call(l, 'host.invoke', { enrollment: r.id, action, resource });
  }
  async receive(link, frame) {
    const s = await this.store.read(),
      d = frame.data;
    if (frame.action === 'host.part') return this.receiver.part(d.enrollment, link, d);
    const m = s.local.member;
    if (
      frame.action !== 'host.invoke' ||
      !m ||
      m.state !== 'approved' ||
      m.id !== d.enrollment ||
      m.linkId !== link.linkId ||
      m.issuer.peerId !== link.peerId
    )
      throw new Error('This contact has no machine grant');
    if (d.action === 'inventory.refresh') {
      this.rescan = true;
      this.wake();
      return { scheduled: true };
    }
    if (this.invoking) throw new Error('Host action busy');
    this.invoking = true;
    try {
      return await invokeHost(localPolicy.parse(s.local.policy), d.action, d.resource);
    } finally {
      this.invoking = false;
    }
  }
  watch(policy) {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    const dirs = new Set([
      ...(process.env.PATH ?? '').split(delimiter).filter((p) => p.startsWith('/')),
      join(this.fed.network.root, '.local'),
      join(homedir(), '.claude/skills'),
      join(homedir(), '.codex/skills'),
      ...Object.values(policy.projects ?? {}).flatMap((p) => [
        p,
        join(p, '.claude/skills'),
        join(p, '.agents/skills')
      ])
    ]);
    for (const dir of [...dirs].slice(0, 110)) {
      try {
        const w = watch(dir, { persistent: false }, (_, name) => {
          if (dir === join(this.fed.network.root, '.local') && name !== 'runtime-state.json') return;
          if (
            Object.values(policy.projects ?? {}).includes(dir) &&
            !['package.json', '.claude', '.agents', '.codex', '.mcp.json'].includes(name)
          )
            return;
          this.rescan = true;
          this.wake(1200);
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {
        /* A configured directory may not exist yet. */
      }
    }
  }
  async cycle() {
    if (this.closing) return;
    const savedState = await this.store.read();
    for (const r of Object.values(savedState.issued)) {
      if (r.relayPending) await this.finalizeRevoke(r.id);
      else if (r.state === 'approving') await this.finalizeApproval(r.id, r.admission);
    }
    const local = savedState.local,
      m = local.member;
    if (!m || ['revoked', 'expired'].includes(m.state)) return;
    if (this.fed.network.gate.phase !== 'open') {
      this.wake(2000);
      return;
    }
    if (m.state === 'pending') {
      await this.registration(m);
      return;
    }
    const l = await this.fed.find('primary');
    if (!l || !['approved', 'pending'].includes(l.status) || l.linkId !== m.linkId) {
      await this.store.edit((s) => {
        s.local.member.state = 'revoked';
        s.local.dirty = false;
      });
      this.unwatch();
      return;
    }
    const policy = localPolicy.parse(local.policy);
    if (this.rescan || !local.snapshot) {
      this.rescan = false;
      try {
        const snapshot = await inspectHost(this.fed.network.root, local.contextId, policy);
        await this.store.edit((s) => {
          if (s.local.member?.id !== m.id || s.local.member.state !== 'approved')
            throw new Error('Local enrollment changed');
          s.local.snapshot = snapshot;
          s.local.revision++;
          s.local.dirty = true;
        });
        this.watch(policy);
      } catch (e) {
        this.rescan = true;
        throw e;
      }
    }
    const saved = (await this.store.read()).local;
    if (!saved.dirty) return;
    const data = Buffer.from(JSON.stringify(saved.snapshot));
    if (data.length > maxBytes) throw new Error('Host snapshot too large');
    const total = Math.ceil(data.length / chunkSize),
      hash = digest(data);
    let result;
    for (let index = 0; index < total; index++) {
      if (this.closing) return;
      result = await this.fed.call(l, 'host.part', {
        enrollment: m.id,
        revision: saved.revision,
        hash,
        total,
        index,
        content: data.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64')
      });
      if (result.installed >= saved.revision) break;
    }
    if (result?.installed !== saved.revision)
      throw new Error('Primary did not install the complete host report');
    await this.store.edit((s) => {
      if (s.local.revision === saved.revision) s.local.dirty = false;
    });
  }
  async leave() {
    await this.store.edit((s) => {
      if (s.local.member) {
        s.local.member.state = 'revoked';
        delete s.local.member.invitation;
        s.local.dirty = false;
      }
    });
    this.unwatch();
    const l = await this.fed.find('primary');
    if (l && ['approved', 'pending'].includes(l.status)) await this.fed.decide(l, 'leave');
    return this.localStatus();
  }
  async policy(p) {
    const value = localPolicy.parse(p);
    await this.store.edit((s) => {
      s.local.policy = value;
    });
    this.rescan = true;
    this.wake();
    return { saved: true };
  }
  unwatch() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    this.unwatch();
    await this.busy;
    await this.store.writes;
  }
}
