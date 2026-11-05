import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { FederationStore } from './federation-store.mjs';
import { snapshotSpec } from './host-inventory.mjs';
import { uuid } from './host-wire.mjs';

export class HostStore extends FederationStore {
  constructor(root) {
    super(root);
    this.file = join(root, '.local', 'hosts', 'state.json');
  }
  fresh() {
    return {
      version: 1,
      issued: {},
      local: { contextId: randomUUID(), policy: {}, revision: 0, dirty: false }
    };
  }
}
export const chunkSize = 22 * 1024,
  maxBytes = 2 * 1024 * 1024;
export const digest = (b) => createHash('sha256').update(b).digest('hex');
export function publicRow(entry, detail = false) {
  const s = entry.report?.snapshot;
  const row = {
    id: entry.id,
    alias: entry.alias,
    state: entry.state,
    hostId: entry.card?.networkId ?? null,
    revision: entry.report?.revision ?? null,
    observedAt: s?.observedAt ?? null,
    receivedAt: entry.report?.receivedAt ?? null,
    contextId: s?.contextId ?? null,
    os: s?.os ?? null,
    runtimes: s?.runtimes ?? [],
    cli: s?.cli.map((x) => x.name) ?? [],
    capabilityCount: s?.capabilities.length ?? 0,
    grants: s?.grants ?? [],
    partial: s?.partial ?? []
  };
  return detail ? { ...row, snapshot: s ?? null } : row;
}
export class SnapshotReceiver {
  constructor(store) {
    this.store = store;
    this.staged = new Map();
  }
  async part(id, link, p) {
    if (!uuid.test(id)) throw new Error('Invalid host enrollment ID');
    if (
      !Number.isSafeInteger(p.revision) ||
      p.revision < 1 ||
      !Number.isInteger(p.total) ||
      p.total < 1 ||
      p.total > Math.ceil(maxBytes / chunkSize) ||
      !Number.isInteger(p.index) ||
      p.index < 0 ||
      p.index >= p.total ||
      typeof p.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.hash) ||
      typeof p.content !== 'string' ||
      p.content.length > Math.ceil(chunkSize / 3) * 4 ||
      p.content.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(p.content)
    )
      throw new Error('Invalid host report chunk');
    const rec = (await this.store.read()).issued[id],
      old = rec?.report;
    if (
      !rec ||
      rec.state !== 'approved' ||
      rec.card.peerId !== link.peerId ||
      rec.card.networkId !== link.networkId ||
      rec.admission?.id !== link.inviteId
    )
      throw new Error('No approved host enrollment');
    if (old && p.revision <= old.revision) {
      if (p.revision === old.revision && p.hash !== old.hash) throw new Error('Host revision conflict');
      return { installed: old.revision };
    }
    const now = Date.now();
    for (const [k, v] of this.staged) if (v.at < now - 120000) this.staged.delete(k);
    let stage = this.staged.get(id);
    if (!stage || p.revision > stage.revision) {
      if (!stage && this.staged.size >= 32) throw new Error('Host report staging is busy');
      stage = { revision: p.revision, hash: p.hash, total: p.total, parts: new Map(), at: now };
      this.staged.set(id, stage);
    }
    if (stage.revision !== p.revision || stage.hash !== p.hash || stage.total !== p.total)
      throw new Error('Stale or conflicting host upload');
    const part = Buffer.from(p.content, 'base64');
    if (
      part.toString('base64') !== p.content ||
      part.length > chunkSize ||
      (p.index < p.total - 1 && part.length !== chunkSize) ||
      !part.length
    )
      throw new Error('Invalid chunk length');
    if (stage.parts.has(p.index) && !stage.parts.get(p.index).equals(part))
      throw new Error('Duplicate chunk conflict');
    stage.parts.set(p.index, part);
    stage.at = now;
    if (stage.parts.size !== stage.total) return { installed: null };
    const data = Buffer.concat(Array.from({ length: stage.total }, (_, i) => stage.parts.get(i)));
    if (data.length > maxBytes || digest(data) !== stage.hash)
      throw new Error('Host report checksum mismatch');
    const snapshot = snapshotSpec.parse(JSON.parse(data));
    const installed = await this.store.edit((s) => {
      const r = s.issued[id];
      if (
        r?.state !== 'approved' ||
        r.card.peerId !== link.peerId ||
        r.card.networkId !== link.networkId ||
        r.admission.id !== link.inviteId
      )
        throw new Error('Host authorization changed');
      if (r.report?.revision === p.revision && r.report.hash !== stage.hash)
        throw new Error('Host revision conflict');
      if (!r.report || r.report.revision < p.revision)
        r.report = { revision: p.revision, hash: stage.hash, snapshot, receivedAt: new Date().toISOString() };
      return r.report.revision;
    });
    if (this.staged.get(id) === stage) this.staged.delete(id);
    return { installed };
  }
}
