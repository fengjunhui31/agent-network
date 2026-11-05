import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson } from './portable-io.mjs';

// Each instance has one owning service. Serialize read/modify/write and publish the
// replacement only after the atomic rename succeeds.
export class FederationStore {
  constructor(root) {
    this.file = join(root, '.local/federation/contacts.json');
    this.writes = Promise.resolve();
  }
  fresh() {
    return { version: 1, contacts: {}, invites: {} };
  }
  async read() {
    await this.writes;
    return readJson(this.file, this.fresh());
  }
  edit(fn) {
    const p = this.writes.then(async () => {
      const state = await readJson(this.file, this.fresh());
      const value = await fn(state);
      await writeJson(this.file, state);
      return value;
    });
    this.writes = p.catch(() => {});
    return p;
  }
}
export class ReturnStore extends FederationStore {
  constructor(root) {
    super(root);
    this.file = join(root, '.local/federation/returns.json');
  }
  fresh() {
    return { version: 1, tickets: {}, received: {}, incoming: {} };
  }
  async ticket(link, run) {
    return this.edit((s) => {
      for (const [id, t] of Object.entries(s.tickets)) if (t.expires <= Date.now()) delete s.tickets[id];
      const prior = Object.values(s.tickets).find((t) => t.linkId === link.linkId && t.runId === run.runId);
      if (prior) return prior;
      if (Object.keys(s.tickets).length >= 4096) throw new Error('Return ticket limit reached');
      const ticket = {
        id: randomUUID(),
        linkId: link.linkId,
        remotePeerId: link.peerId,
        agentId: run.agentId,
        runId: run.runId,
        sessionKey: run.sessionKey ?? null,
        originMessageId: run.originMessageId ?? null,
        expires: Date.now() + 7 * 86400000
      };
      s.tickets[ticket.id] = ticket;
      return ticket;
    });
  }
  async put(collection, event) {
    return this.edit((s) => {
      const rows = s[collection],
        old = rows[event.messageId];
      if (old) {
        if (
          old.linkId !== event.linkId ||
          old.text !== event.text ||
          old.peerId !== event.peerId ||
          old.ticket !== event.ticket ||
          old.replyTo !== event.replyTo
        )
          throw new Error('Message ID conflict');
        return { created: false, event: old };
      }
      for (const [k, v] of Object.entries(rows)) if (v.at < Date.now() - 7 * 86400000) delete rows[k];
      if (Object.keys(rows).length >= 4096) throw new Error('Local peer inbox is full');
      rows[event.messageId] = { ...event, at: Date.now() };
      return { created: true, event: rows[event.messageId] };
    });
  }
}
