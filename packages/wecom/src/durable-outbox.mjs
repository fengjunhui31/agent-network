import { mkdir, readdir, copyFile, chmod } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../shared/io.mjs';

// One local sender. A failed delivery stays queued until reconnect, restart or a new send.
export class DurableOutbox {
  constructor(directory, { deliver, failed, changed } = {}) {
    this.directory = directory; this.deliver = deliver; this.failed = failed; this.changed = changed;
    this.items = new Map(); this.sequence = 0; this.appends = Promise.resolve();
    this.running = null; this.blocked = false; this.stopping = false;
  }
  static async open(directory, handlers) {
    const box = new DurableOutbox(directory, handlers);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(directory)) if (name.endsWith('.json')) {
      const item = await readJson(resolve(directory, name));
      if (item.status === 'sending') { item.status = 'pending'; await writeJson(resolve(directory, name), item); }
      box.items.set(item.id, item); box.sequence = Math.max(box.sequence, item.sequence);
    }
    return box;
  }
  async save(item) {
    await writeJson(resolve(this.directory, `${item.id}.json`), item);
    this.changed?.(this.counts());
  }
  counts() {
    const counts = {};
    for (const item of this.items.values()) counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }
  forRun(runId) { return [...this.items.values()].filter(item => item.runId === runId).sort((a, b) => a.sequence - b.sequence); }
  enqueue({ key = randomUUID(), ...data }) {
    const operation = this.appends.then(async () => {
      if (this.stopping) throw new Error('发送队列正在关闭');
      const id = createHash('sha256').update(key).digest('hex');
      let item = this.items.get(id);
      if (!item) {
        item = { ...data, id, sequence: ++this.sequence, status: 'pending', attempts: 0, createdAt: new Date().toISOString() };
        if (item.kind === 'file') {
          const directory = resolve(this.directory, 'files'); await mkdir(directory, { recursive: true, mode: 0o700 });
          const snapshot = resolve(directory, `${id}-${basename(item.filename)}`);
          await copyFile(item.path, snapshot); await chmod(snapshot, 0o600); item.path = snapshot;
        }
        // Do not expose a message to the sender before its durable record exists.
        await this.save(item); this.items.set(id, item); this.changed?.(this.counts());
      }
      void this.resume();
      return { queued: true, messageId: item.id, delivery: item.status };
    });
    this.appends = operation.catch(() => {});
    return operation;
  }
  next() { return [...this.items.values()].filter(item => item.status !== 'sent').sort((a, b) => a.sequence - b.sequence)[0]; }
  resume() { this.blocked = false; return this.kick(); }
  kick() {
    if (this.stopping || this.paused || this.blocked) return Promise.resolve();
    if (!this.running) this.running = this.drain().catch(async error => {
      this.blocked = true; await this.failed?.(error);
    }).finally(() => {
      this.running = null;
      if (!this.stopping && !this.paused && !this.blocked && this.next()) queueMicrotask(() => { void this.kick(); });
    });
    return this.running;
  }
  async drain() {
    let item;
    while (!this.stopping && !this.paused && (item = this.next())) {
      try {
        Object.assign(item, { status: 'sending', attempts: item.attempts + 1 }); await this.save(item);
        const ack = await this.deliver(item);
        if (ack?.errcode !== undefined && ack.errcode !== 0) throw new Error(`消息发送失败：${ack.errcode}`);
        Object.assign(item, { status: 'sent', sentAt: new Date().toISOString(), ackCode: ack?.errcode ?? 0, error: null });
        await this.save(item);
      } catch (error) {
        Object.assign(item, { status: 'pending', error: error.message }); await this.save(item);
        this.blocked = true; await this.failed?.(error); break;
      }
    }
  }
  async flush(messageIds) {
    await this.appends; await this.resume();
    const pending = messageIds.map(id => this.items.get(id)).find(item => !item || item.status !== 'sent');
    if (pending || messageIds.some(id => !this.items.has(id))) throw new Error(pending?.error ?? '消息已入队，等待恢复发送');
  }
  async close() {
    this.stopping = true; await this.appends; await this.running;
  }
}
