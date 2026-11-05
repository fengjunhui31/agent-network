import { stat } from 'node:fs/promises';
import { conversationSession } from './sessions.mjs';

export const COMPLETION_EVENT = 'member_completed';

// An internal event uses the existing local ingress queue. No message classifier,
// worker heartbeat or general-purpose durable member mailbox is involved.
export class CompletionEvents {
  constructor(network, context, inbox, worker, failed) {
    Object.assign(this, { network, context, inbox, worker, failed });
    this.pending = new Set(); this.settlements = Promise.resolve(); this.closing = false;
    this.handle = run => {
      const operation = this.enqueue(run); this.pending.add(operation);
      void operation.finally(() => this.pending.delete(operation)).catch(() => {});
      return operation;
    };
    network.onChildCompleted = this.handle;
    this.onSettled = run => {
      this.settlements = this.settlements.then(() => this.settle(run)).catch(error => this.failed?.(error));
    };
    network.on('settled', this.onSettled);
  }
  async coordinator(run) {
    const seen = new Set(); let id = run.parentRunId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const parent = await this.network.getResult(id).catch(() => null);
      if (!parent || parent.cancelRequested) return null;
      if (parent.agentId === this.context.agentId) return parent;
      // A live professional parent manages its own children. If it has ended,
      // the original coordinator can take over a late descendant result.
      if (parent.status === 'running') return null;
      id = parent.parentRunId;
    }
    return null;
  }
  async enqueue(run) {
    if (this.closing || run.agentId === this.context.agentId) return false;
    const parent = await this.coordinator(run);
    if (!parent) return false;
    const source = this.context.source(parent);
    if (!source || source.agentId !== this.context.agentId) return false;
    const { item, created } = await this.inbox.add({
      messageId: `member-completed:${run.runId}`, kind: COMPLETION_EVENT,
      agentId: this.context.agentId, userid: source.userid, chatid: source.chatid,
      body: { chattype: source.body.chattype }, sessionKey: conversationSession(source),
      originMessageId: source.id, originRunId: parent.originRunId ?? parent.runId,
      continuationOfRunId: parent.runId, resultRunId: run.runId, memberId: run.agentId,
      files: [], status: 'routing',
      message: `内部事件：专业员工执行结束，不是用户的新请求。你需要接续原任务，检查结果后决定交付、返工或继续协作。\n原用户请求：\n${source.message}\n本次派单时你的请求：\n${parent.input}\n员工执行摘要：\n${JSON.stringify({ runId: run.runId, agentId: run.agentId, status: run.status, answer: run.answer, error: run.error, files: run.outputFiles })}\n先用 get_result 检查该 runId 的完整结果与文件；不要仅凭 completed 判断业务成功。已完成的工作不要重做。沿用原用户来源；需要对外说明时调用 reply_user，若已交付同一结果则不要重复回复。本事件最终文字只作内部记录，交付文件可在最终记录中列出绝对路径。`,
    });
    if (!created) return true;
    await this.prepare(item);
    const active = [this.network.runs.get(parent.runId), ...this.network.runs.values()].find(candidate =>
      candidate?.agentId === this.context.agentId && candidate.status === 'running'
      && (candidate.runId === parent.runId || candidate.continuationOfRunId === parent.runId)
      && this.network.activeRun(candidate.agentId, candidate.sessionKey)?.runId === candidate.runId);
    if (active) {
      await this.inbox.patch(item.id, { status: 'attached', runId: active.runId, nativeMessageId: item.id, consumed: false });
      try {
        await this.network.send({ to: item.agentId, from: run.agentId, expectedRunId: active.runId,
          messageId: item.id, resultRunId: run.runId, message: item.message, files: item.files });
        return true;
      } catch { /* The original turn may have ended while the event was saved. */ }
    }
    await this.inbox.patch(item.id, { status: 'pending', runId: null, nativeMessageId: null, consumed: false });
    if (!this.closing) void this.worker.resume();
    return true;
  }
  async prepare(item) {
    if (item.kind !== COMPLETION_EVENT) return;
    const result = await this.network.getResult(item.resultRunId);
    const files = [];
    for (const entry of result.outputFiles ?? []) if (await stat(entry.path).then(info => info.isFile(), () => false)) files.push(entry.path);
    await this.inbox.patch(item.id, { files });
  }
  async settle(run) {
    if (this.closing) return;
    await this.worker.injections;
    let pending = false;
    for (const item of this.inbox.items.values()) if (item.kind === COMPLETION_EVENT && item.status === 'attached' && item.runId === run.runId) {
      const completed = run.cancelRequested || (item.consumed && run.status === 'completed');
      await this.inbox.patch(item.id, { status: completed ? 'completed' : 'pending', recovered: !completed,
        cancelled: Boolean(run.cancelRequested) });
      pending ||= !completed;
    }
    if (pending && !this.closing) void this.worker.kick();
  }
  async close() {
    this.closing = true;
    if (this.network.onChildCompleted === this.handle) this.network.onChildCompleted = null;
    this.network.off('settled', this.onSettled);
    await Promise.allSettled([...this.pending]); await this.settlements;
  }
}
