import { readFile, writeFile, rename, rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { admissionProtocol, readFrame, encodeFrame, uuid, validClaim } from './wire.mjs';
import { validPeer } from './shared.mjs';

const day = 86400000;
async function load(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
async function save(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function setSponsor(directory, peer, enabled) {
  validPeer(peer);
  const dir = join(directory, 'sponsors');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await save(join(dir, peer + '.json'), enabled);
}
export class Admissions {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'managed-registrations.json');
    this.records = {};
    this.sponsors = new Set();
    this.queue = Promise.resolve();
  }
  async start() {
    this.records = await load(this.file, {});
    await this.refresh();
  }
  async refresh() {
    const dir = join(this.directory, 'sponsors');
    const names = await readdir(dir).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    const next = new Set();
    for (const n of names.filter((x) => x.endsWith('.json')))
      if ((await load(join(dir, n), false)) === true) next.add(validPeer(n.slice(0, -5)));
    this.sponsors = next;
  }
  voucher(peer) {
    return Object.values(this.records).some(
      (r) =>
        r.bootstrap === peer &&
        r.expires > Date.now() &&
        r.state !== 'revoked' &&
        this.sponsors.has(r.sponsor)
    );
  }
  permanent() {
    return Object.values(this.records)
      .filter((r) => r.state === 'approved' && this.sponsors.has(r.sponsor))
      .map((r) => r.card.peerId);
  }
  mutate(fn) {
    const p = this.queue.then(async () => {
      const records = structuredClone(this.records),
        value = await fn(records);
      await save(this.file, records);
      this.records = records;
      return value;
    });
    this.queue = p.catch(() => {});
    return p;
  }
  async handle(peer, q) {
    if (!uuid.test(q?.id)) throw new Error('Invalid admission ID');
    if (q.action === 'issue') {
      if (!this.sponsors.has(peer))
        throw new Error('Relay administrator must sponsor this primary network first');
      validPeer(q.bootstrap);
      if (
        q.bootstrap === peer ||
        !Number.isSafeInteger(q.expires) ||
        q.expires <= Date.now() ||
        q.expires > Date.now() + day + 30000
      )
        throw new Error('Invalid invitation');
      return this.mutate((records) => {
        for (const [id, r] of Object.entries(records))
          if (r.expires <= Date.now() && r.state !== 'approved') delete records[id];
        const old = records[q.id];
        if (old) {
          if (old.sponsor !== peer || old.bootstrap !== q.bootstrap || old.expires !== q.expires)
            throw new Error('Invitation conflict');
          return { state: old.state };
        }
        const all = Object.values(records);
        if (
          all.length >= 2048 ||
          all.filter((r) => r.sponsor === peer && r.state !== 'revoked').length >= 128 ||
          all.some((r) => r.bootstrap === q.bootstrap)
        )
          throw new Error('Invitation limit or duplicate identity');
        records[q.id] = { sponsor: peer, bootstrap: q.bootstrap, expires: q.expires, state: 'issued' };
        return { state: 'issued' };
      });
    }
    const current = this.records[q.id];
    if (!current && q.action === 'revoke' && this.sponsors.has(peer)) return { state: 'revoked' };
    if (!current || !this.sponsors.has(current.sponsor)) throw new Error('Unknown invitation');
    if (q.action === 'claim') {
      if (
        current.bootstrap !== peer ||
        current.expires <= Date.now() ||
        current.state === 'revoked' ||
        current.sponsor === q.card?.peerId ||
        !(await validClaim(q.id, current.sponsor, q.card, q.proof))
      )
        throw new Error('Invalid or expired claim');
      const answer = (r) => ({
        state: r.state,
        ...(r.state === 'approved' ? { admission: r.admission } : {})
      });
      const matches = (r) => r.card?.peerId === q.card.peerId && r.card?.networkId === q.card.networkId;
      if (current.card) {
        if (!matches(current)) throw new Error('Invitation is bound to a different machine');
        return answer(current);
      }
      return this.mutate((records) => {
        const r = records[q.id];
        if (r.state === 'revoked' || r.expires <= Date.now() || (r.card && !matches(r)))
          throw new Error('Invitation no longer available');
        if (!r.card) {
          r.card = { networkId: q.card.networkId, peerId: q.card.peerId };
          r.state = 'pending';
        }
        return answer(r);
      });
    }
    if (current.sponsor !== peer) throw new Error('Only the issuing primary can manage this invitation');
    if (q.action === 'status')
      return { state: current.state, card: current.card ?? null, expires: current.expires };
    if (q.action === 'approve')
      return this.mutate((records) => {
        const r = records[q.id];
        if (r.state === 'approved') return { state: r.state };
        if (
          r.state !== 'pending' ||
          r.expires <= Date.now() ||
          q.admission?.issuer?.peerId !== peer ||
          q.admission?.audience?.peerId !== r.card.peerId ||
          q.admission?.audience?.networkId !== r.card.networkId ||
          q.admission?.preapproved !== true
        )
          throw new Error('Approving a mismatched or expired machine');
        if (
          Object.values(records).some(
            (v) =>
              v !== r &&
              v.state === 'approved' &&
              v.sponsor === peer &&
              (v.card.peerId === r.card.peerId || v.card.networkId === r.card.networkId)
          )
        )
          throw new Error('Machine already enrolled');
        r.state = 'approved';
        r.admission = q.admission;
        return { state: r.state };
      });
    if (q.action === 'revoke')
      return this.mutate((records) => {
        const r = records[q.id];
        r.state = 'revoked';
        delete r.admission;
        return { state: r.state };
      });
    throw new Error('Unknown admission operation');
  }
  async attach(node) {
    await node.handle(
      admissionProtocol,
      async (stream, connection) => {
        const timer = setTimeout(() => stream.abort(new Error('Admission frame timeout')), 8000);
        try {
          if (connection.encryption !== '/noise') throw new Error('Noise required');
          const q = await readFrame(stream);
          stream.send(
            encodeFrame({ ok: true, value: await this.handle(connection.remotePeer.toString(), q) })
          );
        } catch (e) {
          try {
            stream.send(encodeFrame({ ok: false, error: e.message.slice(0, 200) }));
          } catch {}
        } finally {
          try {
            await stream.close({ signal: AbortSignal.timeout(1000) });
          } catch {}
          clearTimeout(timer);
        }
      },
      { maxInboundStreams: 8, maxOutboundStreams: 8 }
    );
  }
}
