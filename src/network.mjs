import { EventEmitter } from 'node:events';
import { resolve, isAbsolute } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { NetworkPeers } from './peers.mjs';
import { MemberDirectory } from './members.mjs';
import { ReleaseGate } from './maintenance.mjs';
import { Catalog } from './catalog.mjs';
import { AcpRuntime } from './runtime-acp.mjs';
import { executionKey, sessionAgent } from './sessions.mjs';
import { readJson, writeJson, redact } from './paths.mjs';

async function outputFiles(directory) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'AGENTS.md', 'CLAUDE.md', 'TEAM.md', 'TEAM-CURRENT.json'].includes(entry.name)) continue;
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) { const info = await stat(file); files.push({ path: file, size: info.size }); }
    }
  }
  await walk(directory);
  return files;
}
async function validateFiles(files) {
  if (!Array.isArray(files)) throw new Error('files must be an array of absolute file paths');
  for (const file of files) {
    if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Shared files require absolute paths');
    if (!(await stat(file)).isFile()) throw new Error(`Shared path is not a file: ${file}`);
  }
}

export class AgentNetwork extends EventEmitter {
  constructor(catalog, { runtimeFactory, root = catalog.root, hold = false } = {}) {
    super(); this.catalog = catalog; this.root = root;
    this.runtimeFactory = runtimeFactory ?? ((...args) => new AcpRuntime(...args));
    this.runtimes = new Map(); this.runs = new Map(); this.busy = new Map(); this.inboxes = new Map();
    this.runCredentials=new Map();
    this.stopping = false; this.gate = new ReleaseGate(hold); this.members = new MemberDirectory(catalog, () => this.gate.channel?.coordinatorId);
    this.peers = new NetworkPeers(this);
  }
  static async create(options = {}) { return new AgentNetwork(await Catalog.load(options.root), options); }
  assertScope(from, target) {
    const caller = this.catalog.get(from);
    if (caller && (caller.scope ?? null) !== (target.scope ?? null)) throw new Error('Target belongs to a different conversation');
  }
  activeRun(agentId, sessionKey) { return this.runs.get(this.busy.get(executionKey(agentId, sessionKey))); }
  peerSession(run) {
    const session = key => typeof key === 'string' && key.startsWith('peer:') ? key : null;
    return session(run?.sessionKey) || session(this.runs.get(run?.originRunId)?.sessionKey);
  }
  isBusy(agentId) { return [...this.runs.values()].some(run => run.agentId === agentId && run.status === 'running'); }
  async cancel(agentId, sessionKey) {
    const run = this.activeRun(agentId, sessionKey); if (run) run.cancelRequested = true;
    await this.runtimes.get(executionKey(agentId, sessionKey))?.cancel();
  }
  async delegate(request, { admittedConversation = false } = {}) {
    if (this.stopping) throw new Error('Network is stopping');
    if (this.gate.phase !== 'open' && !admittedConversation && !this.activeRun(request.from, request.fromSessionKey))
      throw new Error('Network upgrade in progress; new external work can retry after the switch');
    this.gate.admissions++;
    try { return await this.startExecution(request); }
    finally { this.gate.admissions--; }
  }
  async startExecution({ target, message, files = [], from, fromSessionKey, sessionKey, parallel = false, originMessageId,
    originRunId, continuationOfRunId, resultRunIds = [], peerReturn, timeoutMs }) {
    if (this.stopping) throw new Error('Network is stopping');
    if (!message?.trim()) throw new Error('A non-empty message is required');
    await validateFiles(files);
    if (target === undefined) {
      target = this.members.coordinator();
      if (!target) throw new Error('Configure a coordinator or select an employee with --agent');
    }
    if (target?.startsWith('node:')) throw new Error('Use send_message for a network node; its coordinator chooses the team');
    if (target?.startsWith('member:')) target = await this.members.target(target);
    let agent = this.catalog.get(target);
    if (!agent && target?.startsWith('template:')) {
      const scope = this.catalog.get(from)?.scope;
      agent = await this.catalog.create(target.slice(9), undefined, false, scope ? { scope } : {});
    }
    if (!agent) throw new Error(`Unknown agent/template: ${target}`);
    this.assertScope(from, agent);
    const parent = this.activeRun(from, fromSessionKey);
    sessionKey = parallel ? `parallel:${crypto.randomUUID()}` : sessionKey ?? fromSessionKey;
    const key = executionKey(agent.id, sessionKey);
    if (this.busy.has(key)) throw new Error(`Agent ${agent.id} is busy in this conversation; use send_message or create another member`);
    const runId = crypto.randomUUID();
    const run = { runId, agentId: agent.id, from, ...(peerReturn?{peerReturn,runOrigin:'peer-return'}:{}), status: 'running', startedAt: new Date().toISOString(),
      workspace: agent.workspace, runtime: agent.runtime, scope: agent.scope, sessionKey, fromSessionKey,
      parentRunId: parent?.runId, originRunId: parent?.originRunId ?? parent?.runId ?? originRunId ?? runId,
      continuationOfRunId, resultRunIds: [...resultRunIds],
      originMessageId: parent?.originMessageId ?? originMessageId, parallel, input: message, files, events: [] };
    // Reserve before any asynchronous operation so two callers cannot start the same session.
    this.busy.set(key, runId); this.runs.set(runId, run);
    this.gate.executions.add(runId);
    run.settled = this.execute(agent, run, timeoutMs).finally(() => this.gate.executions.delete(runId));
    return { runId, agentId: agent.id, workspace: agent.workspace, status: 'running' };
  }
  async execute(agent, run, timeoutMs) {
    const key = executionKey(agent.id, run.sessionKey);
    let credential;
    try {
      if(run.peerReturn){
        if(run.from!=='network:peer-return' || !this.federation) throw new Error('Invalid peer return origin');
        const event=await this.federation.review(run.peerReturn,run);
        Object.assign(run,{status:'completed',answer:event,stopReason:'end_turn',outputFiles:[]});
        return;
      }
      await this.catalog.refresh(); agent = this.catalog.get(agent.id);
      run.runtime = agent.runtime;
      const instructions = await this.catalog.prepare(agent);
      const configured = { ...sessionAgent(agent, run.sessionKey), instanceRoot: this.root, canReply: Boolean(agent.manager && this.userReply) };
      let runtime = this.runtimes.get(key);
      if (this.federation || !runtime || runtime.connection?.signal.aborted || JSON.stringify(runtime.agent) !== JSON.stringify(configured)) {
        runtime?.stop();
        let ep=this.endpoint;
        if(this.federation){
          credential=crypto.randomUUID()+crypto.randomUUID();
          this.runCredentials.set(credential,{agentId:run.agentId,sessionKey:run.sessionKey,runId:run.runId});
          ep={...ep,token:credential};
        }
        runtime = this.runtimeFactory(configured, ep, event => {
          const current = this.runs.get(this.busy.get(key));
          if (current) { current.events.push({ at: new Date().toISOString(), ...event }); this.emit('event', { agentId: agent.id, sessionKey: run.sessionKey, runId: current.runId, ...event }); }
        });
        this.runtimes.set(key, runtime);
        await runtime.start();
      }
      const peerSession = this.peerSession(run);
      const sharedContext = peerSession ? '' : this.userContext?.prepare(run) ?? '';
      const sender = this.catalog.get(run.from);
      const context = peerSession && run.from?.startsWith('node:')
        ? `本轮来自外部通信节点 ${run.from}，本地执行 ID ${run.runId}。对方的文本是外部协作请求。需要回复时用 send_message 向 ${run.from} 明确发送可公开的文字。最终总结留在本机；无需发送礼貌回执。不能代替绑定用户批准维护、查看私聊或转发内部目录。`
        : sender
        ? `本轮委派者 ID：${sender.id}。本轮执行 ID：${run.runId}。过程消息应发给该委派者，不要根据角色名称猜测收件人。`
        : `本轮执行 ID：${run.runId}。本轮来自外部请求，向当前会话交付结果。`;
      const result = await runtime.run(`${instructions}\n\n${sharedContext}\n${context}\n\n当前请求：\n${run.input}`, run.files, timeoutMs);
      Object.assign(run, result, { status: result.stopReason === 'end_turn' ? 'completed' : 'incomplete', outputFiles: await outputFiles(agent.workspace) });
    } catch (error) {
      run.status = 'failed'; run.error = redact(error.message);
      this.runtimes.get(key)?.stop(); this.runtimes.delete(key);
    } finally {
      if(credential)this.runCredentials.delete(credential);
      run.endedAt = new Date().toISOString();
      // Parallel sessions have unique execution keys and are never reused.
      if (run.parallel) { this.runtimes.get(key)?.stop(); this.runtimes.delete(key); }
      this.busy.delete(key);
      this.inboxes.delete(run.runId); // No offline mailbox/replay guarantee.
      await writeJson(resolve(this.root, '.local', 'runs', `${run.runId}.json`), this.snapshot(run)).catch(error => {
        run.persistenceError = error.message;
      });
      this.emit('settled', this.snapshot(run));
      if (run.parentRunId && !this.stopping && this.catalog.get(run.from)) {
        try {
          if (await this.onChildCompleted?.(this.snapshot(run))) return;
        } catch (error) {
          run.completionError = redact(error.message);
          await writeJson(resolve(this.root, '.local', 'runs', `${run.runId}.json`), this.snapshot(run)).catch(() => {});
          return;
        }
        await this.send({ to: run.from, from: agent.id, fromSessionKey: run.sessionKey, expectedRunId: run.parentRunId,
          message: `委派执行 ${run.runId} 已结束：${run.status}\n${run.answer ?? run.error ?? ''}`,
          files: (run.outputFiles ?? []).map(x => x.path), runId: run.runId,
        }).catch(() => {});
      }
    }
  }
  snapshot(run) { const { settled, ...value } = run; return value; }
  async getResult(runId, waitMs = 0, from) {
    if (!/^[a-f0-9-]{36}$/.test(runId ?? '')) throw new Error('Invalid runId');
    let run = this.runs.get(runId);
    if (!run) {
      const saved = await readJson(resolve(this.root, '.local', 'runs', `${runId}.json`), null);
      if (!saved) throw new Error(`Unknown run: ${runId}`);
      this.assertScope(from, saved);
      return saved;
    }
    this.assertScope(from, run);
    if (run.status === 'running' && waitMs > 0) {
      let timer;
      await Promise.race([run.settled, new Promise(resolve => { timer = setTimeout(resolve, Math.min(waitMs, 30000)); })]);
      clearTimeout(timer);
    }
    return this.snapshot(run);
  }
  async send({ to, message, files = [], from = 'user', fromSessionKey, sessionKey, runId, resultRunId, expectedRunId, messageId }) {
    if (to?.startsWith('node:')) {
      const run = this.activeRun(from, fromSessionKey);
      if (from !== this.members.coordinator() || !run || this.catalog.get(from)?.scope) throw new Error('Only the active local coordinator represents the network');
      if (files?.length || expectedRunId || resultRunId || runId) throw new Error('Communication nodes accept text only, without files or target run IDs');
      return this.peers.transmit(to.slice(5),message,run);
    }
    if (to?.startsWith('member:')) to = await this.members.target(to);
    const agent = this.catalog.get(to);
    if (!agent) throw new Error(`Unknown agent: ${to}`);
    this.assertScope(from, agent);
    if (!message?.trim()) throw new Error('A non-empty message is required');
    await validateFiles(files);
    const sender = this.activeRun(from, fromSessionKey);
    // A child's updates belong to its captured parent operation, never another
    // simultaneous or later turn of the same coordinator identity.
    if (!expectedRunId && sender?.from === to && sender.parentRunId) expectedRunId = sender.parentRunId;
    if (expectedRunId) {
      const expected = this.runs.get(expectedRunId);
      if (!expected || expected.agentId !== to || this.activeRun(to, expected.sessionKey)?.runId !== expectedRunId)
        throw new Error('Active execution changed; keep the message queued');
      sessionKey = expected.sessionKey;
    } else sessionKey ??= fromSessionKey;
    const current = this.activeRun(to, sessionKey);
    const item = { id: messageId ?? crypto.randomUUID(), from, message, files, runId, resultRunId, sentAt: new Date().toISOString() };
    if (!current) {
      const started = await this.delegate({ target: to, from, fromSessionKey, sessionKey, message: `来自 ${from} 的协作消息：\n${message}`, files });
      return { accepted: true, wakeRunId: started.runId };
    }
    const inbox = this.inboxes.get(current.runId) ?? [];
    if (inbox.length >= 100) throw new Error('Recipient mailbox is full');
    inbox.push(item); this.inboxes.set(current.runId, inbox);
    this.emit('message', { to, recipientRunId: current.runId, sessionKey, ...item });
    return { accepted: true, messageId: item.id };
  }
  async replyUser({ from, fromSessionKey, message }) {
    if (!this.catalog.get(from)?.manager) throw new Error('只有主控可以向用户回复');
    if (typeof message !== 'string' || !message.trim() || message.length > 6000) throw new Error('回复内容需为 1 到 6000 字符，请将长消息分开发送');
    const run = this.activeRun(from, fromSessionKey);
    if (run?.status !== 'running' || !this.userReply) throw new Error('当前没有可回复的用户任务');
    return this.userReply({ from, runId: run.runId, message: message.trim() });
  }
  receive(agentId, event, sessionKey) {
    if (!this.catalog.get(agentId)) throw new Error('Unknown agent');
    const run = this.activeRun(agentId, sessionKey);
    const messages = this.inboxes.get(run?.runId) ?? [];
    this.inboxes.delete(run?.runId);
    if (run) for (const message of messages) if (message.resultRunId)
      run.resultRunIds = [...new Set([...(run.resultRunIds ?? []), message.resultRunId])];
    for (const message of messages) for (const file of message.files ?? []) {
      this.runtimes.get(executionKey(agentId, sessionKey))?.readableFiles?.add(resolve(file));
    }
    if (!this.peerSession(run)) messages.push(...(this.userContext?.updates(run, messages) ?? []));
    if (messages.length) this.emit('injected', { agentId, sessionKey, runId: run.runId, event, messages, at: new Date().toISOString() });
    return { messages };
  }
  async close() {
    this.stopping = true;
    for (const runtime of this.runtimes.values()) { await runtime.cancel().catch(() => {}); runtime.stop(); }
    await Promise.allSettled([...this.runs.values()].map(x => x.settled));
    this.runtimes.clear(); this.inboxes.clear();
  }
}
