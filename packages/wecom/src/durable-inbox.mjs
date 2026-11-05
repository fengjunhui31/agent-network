import { readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from '../shared/io.mjs';
import { conversationKey, conversationSession } from './sessions.mjs';

export function sameConversation(left, right) {
  return left?.chatid === right?.chatid && left?.body?.chattype === right?.body?.chattype;
}

export class DurableInbox {
  constructor(directory) { this.directory = directory; this.items = new Map(); this.sequence = 0; this.writes = Promise.resolve(); this.admitting = new Set(); }
  static async open(directory) {
    const inbox = new DurableInbox(directory); await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(directory)) if (name.endsWith('.json')) {
      const item = await readJson(resolve(directory, name)); inbox.items.set(item.id, item);
      inbox.sequence = Math.max(inbox.sequence, item.sequence);
    }
    return inbox;
  }
  async save(item) {
    const snapshot = structuredClone(item);
    this.writes = this.writes.catch(() => {}).then(() => writeJson(resolve(this.directory, `${item.id}.json`), snapshot));
    await this.writes; this.onChange?.(); return item;
  }
  async add(data) {
    const id = createHash('sha256').update(data.messageId).digest('hex');
    if (this.items.has(id)) return { item: this.items.get(id), created: false };
    const item = { ...data, id, sequence: ++this.sequence, receivedAt: new Date().toISOString(), status: data.status ?? 'pending', attempts: 0 };
    this.admitting.add(id); this.items.set(id, item);
    try { await this.save(item); }
    catch (error) { this.items.delete(id); throw error; }
    finally { this.admitting.delete(id); }
    return { item, created: true };
  }
  async patch(id, patch) {
    const item = this.items.get(id); if (!item) throw new Error('Unknown queue item');
    Object.assign(item, patch, { updatedAt: new Date().toISOString() }); return this.save(item);
  }
  next(excluded = new Set()) {
    return [...this.items.values()].filter(x => ['preparing', 'pending', 'reply_pending'].includes(x.status)
      && !this.admitting.has(x.id) && !excluded.has(conversationKey(x))).sort((a, b) => a.sequence - b.sequence)[0];
  }
  counts(agentId, conversation) {
    const counts = {};
    for (const item of this.items.values()) if ((!agentId || item.agentId === agentId) && (!conversation || sameConversation(item, conversation)))
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }
  async retry(agentId, conversation) {
    for (const item of this.items.values()) if (item.agentId === agentId && item.status === 'failed' && (!conversation || sameConversation(item, conversation)))
      await this.patch(item.id, { status: 'pending', error: null, preparationResult: null });
  }
  async recover(network) {
    for (const item of this.items.values()) {
      if (!['running', 'attached', 'preparing', 'routing'].includes(item.status)) continue;
      const run = item.runId ? await network.getResult(item.runId).catch(() => null) : null;
      const completed = run?.status === 'completed';
      const status = item.status === 'attached' && item.consumed && completed ? 'completed' : completed && item.status === 'running' ? 'reply_pending' : 'pending';
      await this.patch(item.id, { status, recovered: true });
    }
  }
}

// One active turn per conversation, with bounded parallelism across conversations.
export class QueuedCoordinator {
  constructor(network, inbox, { deliver, started, failed, prepare, maxConcurrent = 4, idleTimeoutMs = 900000, maxTurnMs } = {}) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be a positive integer');
    for (const duration of [idleTimeoutMs, maxTurnMs]) {
      if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 1 || duration > 2147483647)) {
        throw new Error('Channel timeouts must be positive timer durations in milliseconds');
      }
    }
    this.turnLimits = network.supportsIdleTimeout ? { idleTimeoutMs, timeoutMs: maxTurnMs } : { timeoutMs: maxTurnMs ?? idleTimeoutMs };
    Object.assign(this, { network, inbox, deliver, started, failed, prepare, maxConcurrent });
    this.stopping = false; this.running = null; this.active = new Map(); this.blocked = new Set();
    this.attachments = new Map(); this.injections = Promise.resolve();
    this.onInjected = event => {
      this.injections = this.injections.then(async () => {
        for (const item of inbox.items.values()) if (item.status === 'attached' && item.runId === event.runId
          && event.messages.some(m => m.id === item.nativeMessageId)) await inbox.patch(item.id, { consumed: true });
      }).catch(error => this.failed?.(error));
    };
    network.on('injected', this.onInjected);
  }
  activeFor(item) { return this.active.get(conversationKey(item)); }
  forRun(runId) { return [...this.active.values()].find(item => item.runId === runId); }
  async enqueue(item) {
    this.blocked.delete(conversationKey(item));
    // Downloading one supplement must not hold up ingress in another chat.
    void this.attach(item).catch(error => this.failed?.(error));
    void this.kick();
  }
  attach(item) {
    if (this.attachments.has(item.id)) return this.attachments.get(item.id);
    const pending = this.attachToCurrent(item).finally(() => this.attachments.delete(item.id));
    this.attachments.set(item.id, pending); return pending;
  }
  async attachToCurrent(item) {
    // Internal results are routed to their exact parent by CompletionEvents.
    if (['member_completed','peer_return','owner_request'].includes(item.kind)) return;
    const current = this.activeFor(item);
    if (this.stopping || !current?.runId || current === item || item.status !== 'pending'
      || this.network.activeRun(item.agentId, conversationSession(item))?.runId !== current.runId) return;
    if (!item.files) await this.prepare?.(item);
    if (this.stopping || this.network.activeRun(item.agentId, conversationSession(item))?.runId !== current.runId) return;
    // Persist ownership before making the message visible to a native hook.
    await this.inbox.patch(item.id, { status: 'attached', runId: current.runId, nativeMessageId: item.id, consumed: false });
    try {
      await this.network.send({ to: item.agentId, from: `wecom:${item.userid}`, messageId: item.id,
        message: `用户补充（队列 ${item.sequence}）：\n${item.message}`, files: item.files ?? [], expectedRunId: current.runId });
    } catch {
      await this.inbox.patch(item.id, { status: 'pending', runId: null, nativeMessageId: null, consumed: false });
    }
  }
  resume() { this.blocked.clear(); return this.kick(); }
  kick() {
    if (this.stopping || (this.network.gate && this.network.gate.phase !== 'open')) return Promise.resolve();
    if (!this.running) this.running = new Promise(resolve => { this.idle = resolve; });
    const draining = this.running;
    let item;
    while (this.active.size < this.maxConcurrent
      && (item = this.inbox.next(new Set([...this.active.keys(), ...this.blocked])))) {
      const key = conversationKey(item);
      this.active.set(key, item);
      void this.process(item).catch(error => this.failed?.(error)).finally(() => {
        this.active.delete(key); this.kick(); this.resolveIdle();
      });
    }
    this.resolveIdle(); return draining;
  }
  resolveIdle() {
    if (!this.active.size) { const idle = this.idle; this.running = null; this.idle = null; idle?.(); }
  }
  async process(item) {
    try {
      let result;
      if (item.status === 'reply_pending') result = item.preparationResult ?? await this.network.getResult(item.runId);
      else {
        await this.inbox.patch(item.id, { status: 'running', runId: null, attempts: item.attempts + 1, sessionKey: conversationSession(item) });
        try { await this.prepare?.(item); }
        catch (error) {
          result = { runId: crypto.randomUUID(), status: 'failed', error: error.message, workspace: this.network.catalog.get(item.agentId).workspace };
          await this.inbox.patch(item.id, { runId: result.runId, preparationResult: result });
        }
        if (this.stopping) return;
        if (!result) {
          const recovery = item.recovered ? '这是中断后的恢复。先核对会话记录和工作区中已完成的操作，继续未完成部分，避免重复外部动作。\n' : '';
          const run = await this.network.delegate({ target: item.agentId, sessionKey: item.sessionKey,
            from: item.kind==='peer_return'?'network:peer-return':item.kind==='owner_request'?'network:owner': item.kind === 'member_completed' ? 'network:completion' : `wecom:${item.userid}`,
            originMessageId: item.originMessageId ?? item.id, originRunId: item.originRunId, peerReturn:item.peerReturn,
            continuationOfRunId: item.continuationOfRunId, resultRunIds: item.resultRunId ? [item.resultRunId] : [],
            files: item.files ?? [], message: `${recovery}${item.historyContext ?? ''}${item.message}`, ...this.turnLimits }, { admittedConversation: true });
          await this.inbox.patch(item.id, { runId: run.runId });
          await this.started?.(item);
          // Supplements arriving while the runtime was starting join this turn.
          for (const pending of this.inbox.items.values()) if (pending !== item && sameConversation(pending, item)
            && pending.agentId === item.agentId && pending.status === 'pending') void this.attach(pending).catch(error => this.failed?.(error));
          await this.network.runs.get(run.runId).settled;
          if (this.stopping) return;
          await Promise.allSettled([...this.attachments].filter(([id]) => conversationKey(this.inbox.items.get(id)) === conversationKey(item)).map(([, promise]) => promise));
          result = await this.network.getResult(run.runId);
        }
        await this.inbox.patch(item.id, { status: 'reply_pending' });
      }
      if (this.stopping) return;
      await this.deliver(item, result);
      await this.inbox.patch(item.id, { status: result.status === 'completed' ? 'completed' : 'failed', error: result.error ?? null });
      await this.injections;
      for (const attached of this.inbox.items.values()) if (attached.status === 'attached' && attached.runId === item.runId)
        await this.inbox.patch(attached.id, { status: attached.consumed && result.status === 'completed' ? 'completed' : 'pending', recovered: true });
    } catch (error) {
      if (this.stopping) return;
      if (item.status !== 'reply_pending') await this.inbox.patch(item.id, { status: 'failed', error: error.message });
      else this.blocked.add(conversationKey(item)); // Only this conversation waits for delivery recovery.
      await this.failed?.(error);
    }
  }
  async close() {
    this.stopping = true; this.network.off('injected', this.onInjected);
    await Promise.allSettled([...this.attachments.values()]); await this.injections; await this.inbox.writes;
  }
}
