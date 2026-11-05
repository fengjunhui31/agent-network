import AiBot from '@wecom/aibot-node-sdk';
import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { readJson, writeJson, redact } from '../shared/io.mjs';
import { textOf, clipText, incomingFiles, outgoingFiles, sendFiles } from './wecom-files.mjs';
import { commandOf, conversationAgent, restoreSharedAssistant } from './wecom-routing.mjs';
import { DurableInbox, QueuedCoordinator, sameConversation } from './durable-inbox.mjs';
import { DurableOutbox } from './durable-outbox.mjs';
import { SharedContext } from './shared-context.mjs';
import { CompletionEvents, COMPLETION_EVENT } from './completion-events.mjs';
import { conversationSession, sessionTag } from './sessions.mjs';

export class WecomBridge {
  constructor(network, client, config, options = {}) {
    const local = resolve(network.root ?? network.catalog.root, '.local');
    this.network = network; this.client = client; this.config = config;
    this.configFile = options.configFile ?? resolve(local, 'wecom.json');
    this.statusFile = options.statusFile ?? resolve(local, 'wecom-status.json');
    this.logFile = options.logFile ?? resolve(local, 'wecom-events.jsonl');
    this.status = { connection: 'connecting', bound: Boolean(config.allowedUserIds?.length),
      enabledGroups: config.enabledGroupIds?.length ?? 0, maxConcurrentConversations: config.maxConcurrentConversations ?? 4,
      received: 0, completedReplies: 0 };
    this.id = 'wecom';
    this.features = ['外部回复续办到原会话','持久消息入口','多会话并发','同会话补充注入','企微跨会话共享记忆','向原会话回复','持久发送队列','员工完成后自动续办'];
    if (network.gate) network.gate.channel = this;
    if (network.catalog) network.catalog.channel = this;
    this.pendingCallbacks = 0;
    this.seen = new Set(); this.messageQueue = Promise.resolve(); this.statusQueue = Promise.resolve();
    this.onUserReply = request => this.enqueueUserReply(request);
    this.network.userReply = this.onUserReply;
    const inboxDirectory = options.inboxDirectory ?? resolve(local, 'wecom-inbox');
    this.ready = DurableInbox.open(inboxDirectory).then(async inbox => {
      await inbox.recover(network);
      await restoreSharedAssistant(network, config, inbox);
      this.inbox = inbox;
      inbox.onChange = () => { void this.update({ queue: inbox.counts() }); };
      this.outbox = await DurableOutbox.open(options.outboxDirectory ?? resolve(inboxDirectory, '../wecom-outbox'), {
        deliver: async item => {
          let ack;
          if (item.kind === 'file') { await sendFiles(this.client, item.chatid, [item]); ack = { errcode: 0 }; }
          else ack = await this.client.sendMessage(item.chatid, { msgtype: 'markdown', markdown: { content: clipText(item.content) } });
          if (ack?.errcode === undefined || ack.errcode === 0) await this.context.recordReply(item).catch(error => this.failure(error));
          return ack;
        },
        failed: error => this.failure(error),
        changed: outbox => { void this.update({ outbox }); },
      });
      this.outbox.paused = network.gate?.phase === 'holding';
      this.context = await SharedContext.open(network, inbox, this.outbox, config.agentId);
      this.network.userContext = this.context;
      await this.update({ queue: inbox.counts(), outbox: this.outbox.counts(), sharedMemory: true, memoryRecords: this.context.memory.entries.size });
      this.worker = new QueuedCoordinator(network, inbox, {
        maxConcurrent: config.maxConcurrentConversations ?? 4,
        prepare: async item => {
          if(item.kind==='peer_return')return;
          await this.completions?.prepare(item);
          if (!item.files) await inbox.patch(item.id, { files: await incomingFiles(this.client, item.body, network.catalog.get(item.agentId).workspace) });
          await this.context.recordFiles(item);
          const history = await this.writeConversationHistory(item);
          item.historyContext = `本会话此前消息与结果索引：${history}。新会话或需要回顾时查阅；旧共享原生会话与文件仍保留。\n`;
        },
        started: async item => {
          await this.update({ lastRunId: item.runId });
        },
        deliver: (item, run) => this.finish(run, item),
        failed: error => this.failure(error),
      });
      this.completions = new CompletionEvents(network, this.context, inbox, this.worker, error => this.failure(error));
    });
  }
  clean(value) { return redact(value, [this.config.secret, this.config.pairingCode]); }
  async record(type, data = {}) {
    await appendFile(this.logFile, `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`, { mode: 0o600 });
  }
  async update(patch) {
    Object.assign(this.status, patch, { updatedAt: new Date().toISOString() });
    this.statusQueue = this.statusQueue.catch(() => {}).then(() => writeJson(this.statusFile, this.status));
    await this.statusQueue;
  }
  async failure(error) {
    const message = this.clean(error.message ?? error);
    await this.update({ lastError: message }); await this.record('error', { message });
    console.error(`WeCom: ${message}`);
  }
  start() {
    this.client.on('authenticated', () => {
      void this.update({ connection: 'authenticated', authenticatedAt: new Date().toISOString(), lastError: null });
      void this.ready.then(() => {
        this.outbox.paused = this.network.gate?.phase === 'holding';
        void this.outbox.resume(); void this.worker.resume();
      }).catch(error => this.failure(error));
      console.log('WeCom authenticated');
    });
    this.client.on('disconnected', reason => { void this.update({ connection: 'disconnected', reason: this.clean(reason) }); });
    this.client.on('error', error => { void this.failure(error); });
    this.client.on('message', frame => {
      if (this.closing) return;
      this.pendingCallbacks++;
      this.messageQueue = this.messageQueue.then(() => this.receive(frame, true)).catch(error => this.failure(error))
        .finally(() => { this.pendingCallbacks--; });
    });
    void this.update({}); this.client.connect(); return this;
  }
  async reply(frame, streamId, content, finish) {
    const ack = await this.client.replyStream(frame, streamId, clipText(content), finish);
    if (ack.errcode !== undefined && ack.errcode !== 0) throw new Error(`企业微信回复失败：${ack.errcode}`);
    return ack;
  }
  async sendText(chatid, content) {
    const queued = await this.outbox.enqueue({ chatid, kind: 'text', content, origin: 'system' });
    await this.outbox.flush([queued.messageId]);
    return { errcode: 0 };
  }
  async enqueueUserReply({ from, runId, message }) {
    await this.ready;
    const run = this.network.runs.get(runId);
    const item = this.context.source(run);
    if (!item || from !== this.config.agentId || item.agentId !== from || run?.agentId !== from
      || run.status !== 'running' || this.network.activeRun(from, run.sessionKey)?.runId !== runId) throw new Error('当前没有可回复的用户任务');
    const queued = await this.outbox.enqueue({ ...(item.kind==='owner_request'?{key:'owner-post:'+item.id}:{}),chatid: item.chatid, runId, originMessageId: item.id, kind: 'text', content: message, origin: 'tool' });
    await this.record('user_reply_queued', { runId, messageId: queued.messageId, chattype: item.body.chattype });
    return { ...queued, note: '已入发送队列。你可以继续工作；本轮后续对外文字请继续调用 reply_user，最终输出只作内部记录。' };
  }
  async receive(frame, acceptedBeforeClose = false) {
    await this.ready;
    if (this.closing && !acceptedBeforeClose) return;
    const body = frame.body ?? {}; const userid = body.from?.userid;
    // The authenticated SDK connection identifies the bot. Callback aibotid need not be the login botId.
    await this.update({ callbacks: (this.status.callbacks ?? 0) + 1, lastCallbackAt: new Date().toISOString() });
    await this.record('callback', { msgtype: body.msgtype, chattype: body.chattype, hasUserid: Boolean(userid), hasMsgid: Boolean(body.msgid) });
    if (!userid || !['single', 'group'].includes(body.chattype) || !body.msgid) return;
    if (body.chattype === 'group' && !body.chatid) return;
    if (this.seen.has(body.msgid)) return;
    this.seen.add(body.msgid); if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    let message = textOf(body).trim(); let justBound = false;
    const isOwner = (this.config.allowedUserIds ?? []).includes(userid);
    const command = commandOf(message);
    const coordinatorName = this.network.catalog.get(this.config.agentId)?.name ?? this.config.agentId;
    if (body.chattype === 'group') {
      const streamId = crypto.randomUUID();
      const enabled = this.config.enabledGroupIds ?? [];
      if (['启用本群', '停用本群'].includes(command)) {
        if (!isOwner) return;
        this.config.enabledGroupIds = command === '启用本群' ? [...new Set([...enabled, body.chatid])] : enabled.filter(id => id !== body.chatid);
        await writeJson(this.configFile, this.config);
        await this.update({ enabledGroups: this.config.enabledGroupIds.length });
        await this.record('group_access', { chatid: body.chatid, enabled: command === '启用本群' });
        await this.reply(frame, streamId, command === '启用本群'
          ? `本群已启用。所有成员都可以 @ 我下任务；各群和私聊都是同一位协调者（${coordinatorName}），结果和文件回复到提出任务的会话。`
          : '本群已停用，不再接收新任务；已开始的任务仍会在本群返回结果。', true);
        return;
      }
      if (!enabled.includes(body.chatid)) {
        if (!isOwner || command || !['text', 'voice', 'file', 'mixed'].includes(body.msgtype) || (!message && body.msgtype !== 'file')) return;
        this.config.enabledGroupIds = [...enabled, body.chatid];
        await writeJson(this.configFile, this.config);
        await this.update({ enabledGroups: this.config.enabledGroupIds.length });
        await this.record('group_access', { chatid: body.chatid, enabled: true, reason: 'owner_task' });
      }
    } else if (!isOwner) {
      const enteredCode = message.match(/绑定[\s:：]*([0-9a-f]{8})/i)?.[1]?.toUpperCase();
      if (this.config.allowedUserIds?.length || !this.config.pairingCode || enteredCode !== this.config.pairingCode) return;
      this.config.allowedUserIds = [userid]; delete this.config.pairingCode;
      await writeJson(this.configFile, this.config);
      await this.update({ bound: true, boundAt: new Date().toISOString() }); await this.record('bound', { userid });
      justBound = true;
      message = '我已经通过企业微信连接到你。请用两句话确认连接，并告诉我如何让你组织成员处理任务。不需要调用工具。';
    }
    const streamId = crypto.randomUUID();
    await this.update({ received: this.status.received + 1, lastInboundAt: new Date().toISOString(), lastMessageId: body.msgid });
    await this.record('received', { messageId: body.msgid, userid, msgtype: body.msgtype, chattype: body.chattype, chatid: body.chatid });
    const agent = await conversationAgent(this.network.catalog, this.config, body);
    const chatid = body.chattype === 'group' ? body.chatid : userid;
    const conversation = { chatid, body, agentId: agent.id };
    const sessionKey = conversationSession(conversation);
    const activeRuns = this.context.activeFor(conversation);
    const activeHere = activeRuns.length > 0;
    if (command === '队列') {
      await this.reply(frame, streamId, `本会话待办状态：${JSON.stringify(this.inbox.counts(undefined, conversation))}`, true); return;
    }
    if (command === '重试') {
      await this.inbox.retry(agent.id, conversation); void this.worker.resume();
      await this.reply(frame, streamId, '本会话未完成的报错任务已重新排队。', true); return;
    }
    if (command === 'ping' || command === '状态') {
      await this.reply(frame, streamId, activeHere ? '连接正常，正在处理本会话的任务；你可以继续补充要求。'
        : this.network.isBusy(agent.id) ? `连接正常，${coordinatorName}也在处理其他会话；你可以直接发送，本会话能同时处理。`
          : `连接正常，${coordinatorName}空闲，可以直接发送任务。`, true); return;
    }
    if (command === '停止') {
      if (!activeHere) { await this.reply(frame, streamId, '本会话当前没有正在执行的任务。', true); return; }
      await Promise.all(activeRuns.map(run => this.network.cancel(agent.id, run.sessionKey)));
      await this.reply(frame, streamId, '已请求停止本会话正在进行的执行。', true); return;
    }
    if (!['text', 'voice', 'file', 'mixed'].includes(body.msgtype) || (body.msgtype === 'mixed' && !message)) {
      await this.reply(frame, streamId, '目前请发送文字、语音转写或文件。', true); return;
    }
    if (!message) message = '收到一个文件。请简要说明文件类型和你能怎样处理它，再问我需要完成什么任务。';
    const { item, created } = await this.inbox.add({ messageId: body.msgid, body, agentId: agent.id, userid,
      chatid, sessionKey,
      message: `用户 ${userid}（${isOwner || justBound ? '已绑定负责人' : '群成员'}）通过${body.chattype === 'group' ? '已启用的企业微信群聊' : '已绑定的企业微信单聊'}发送。当前回复目的地：${body.chattype}:${chatid}。\n${message}\n\n按共享网络规范处理本轮请求；历史记忆不改变当前收件人。`,
      status: 'pending', files: body.msgtype === 'file' ? null : [] });
    if (!created) return;
    try {
      await this.context.recordInput(item);
      await this.worker.enqueue(item);
    } catch (error) {
      await this.inbox.patch(item.id, { status: 'failed', error: this.clean(error.message) });
      await this.sendText(item.chatid, `这次没有完成，待办已保留：${this.clean(error.message)}`); throw error;
    }
  }
  async writeConversationHistory(item) {
    const entries = [];
    for (const prior of [...this.inbox.items.values()].filter(x => x.id !== item.id && sameConversation(x, item))
      .sort((a, b) => a.sequence - b.sequence)) {
      const run = prior.runId ? await this.network.getResult(prior.runId).catch(() => null) : null;
      const replies = prior.runId ? this.outbox.forRun(prior.runId).filter(x => x.kind === 'text' && x.origin!=='peer-return').map(x => x.content) : [];
      entries.push({ messageId: prior.messageId, at: prior.receivedAt, user: prior.userid,
        kind: prior.kind ?? 'user',
        message: textOf(prior.body ?? {}) || prior.message, status: prior.status,
        replies: prior.kind==='peer_return'?[]:replies.length ? replies : run?.answer ? [run.answer] : [], files: run?.outputFiles ?? [] });
    }
    const file = resolve(this.network.catalog.get(item.agentId).workspace, 'history', 'conversations', `${sessionTag(conversationSession(item))}.json`);
    await writeJson(file, { sessionKey: conversationSession(item), entries });
    return file;
  }
  async ownerRequest({groupId,message,key}) {
    if(!this.config.enabledGroupIds?.includes(groupId))throw new Error('Select an enabled group');
    if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(key)||typeof message!=='string'||!message.trim()||message.length>8000)throw new Error('Provide a unique request key and a nonempty message');
    await this.ready;
    const {item,created}=await this.inbox.add({kind:'owner_request',messageId:'owner-request:'+key,agentId:this.config.agentId,
      userid:'local-owner',chatid:groupId,body:{chattype:'group'},files:[],message});
    if(item.chatid!==groupId||item.message!==message)throw new Error('Request key already used with a different group or message');
    if(created)void this.worker.kick().catch(error=>this.failure(error));return {id:item.id,created,status:item.status};
  }
  async peerReturn(ticket,event) {
    await this.ready;
    const source=this.inbox.items.get(ticket.originMessageId);
    if(!source || source.agentId!==this.config.agentId || source.agentId!==ticket.agentId ||
      conversationSession(source)!==ticket.sessionKey)return null;
    const active=this.network.activeRun(ticket.agentId,ticket.sessionKey);
    if(active?.runId===ticket.runId){
      const content=await this.network.federation.review(event.messageId,{agentId:ticket.agentId,sessionKey:ticket.sessionKey,
        continuationOfRunId:ticket.runId,originMessageId:ticket.originMessageId});
      const queued=await this.outbox.enqueue({key:'peer-result:'+event.linkId+':'+event.messageId,chatid:source.chatid,
        runId:ticket.runId,originMessageId:source.id,kind:'text',content,origin:'peer-return'});
      return {outboxId:queued.messageId,mode:'active'};
    }
    const {item}=await this.inbox.add({messageId:'peer-return:'+event.linkId+':'+event.messageId,
      kind:'peer_return',agentId:ticket.agentId,userid:source.userid,chatid:source.chatid,body:{chattype:source.body.chattype},
      sessionKey:ticket.sessionKey,originMessageId:source.id,originRunId:source.originRunId??ticket.runId,
      continuationOfRunId:ticket.runId,peerReturn:event.messageId,peerLinkId:event.linkId,files:[],message:'验收已验证的外部节点回复。'});
    void this.worker.kick();return {queueItemId:item.id};
  }
  async finish(run, item) {
    try {
      if(['peer_return','owner_request'].includes(item.kind) && run.status!=='completed')return;
      const explicitReplies = this.outbox.forRun(run.runId).some(message => message.origin === 'tool');
      const answer = run.status === 'completed' ? run.answer || '任务已结束。' : `这次执行未完成：${this.clean(run.error ?? run.stopReason ?? run.status)}`;
      if ((!explicitReplies && item.kind !== COMPLETION_EVENT) || run.status !== 'completed') await this.outbox.enqueue({ key: item.kind==='peer_return' ? 'peer-result:'+item.peerLinkId+':'+item.peerReturn : item.kind==='owner_request'?'owner-post:'+item.id:`final:${run.runId}`,
        chatid: item.chatid, runId: run.runId, originMessageId: item.id, kind: 'text', content: answer, origin: item.kind==='peer_return'?'peer-return':'final' });
      const files = !['peer_return','owner_request'].includes(item.kind) && run.status === 'completed' ? await outgoingFiles(this.network, run, answer) : [];
      for (const file of files) await this.outbox.enqueue({ key: `file:${run.runId}:${file.path}`,
        chatid: item.chatid, runId: run.runId, originMessageId: item.id, kind: 'file', ...file, origin: item.kind==='peer_return'?'peer-return':'final' });
      await this.outbox.flush(this.outbox.forRun(run.runId).map(message => message.id));
      await this.update({ completedReplies: this.status.completedReplies + 1, lastReplyAt: new Date().toISOString(),
        lastReply: { runId: run.runId, runStatus: run.status, model: run.model, chattype: item.body.chattype, ackCode: 0 } });
      await this.record('replied', { runId: run.runId, status: run.status, model: run.model, chattype: item.body.chattype,
        chatid: item.body.chatid, ackCode: 0, explicitReplies });
      if (files.length) await this.record('files_sent', { runId: run.runId, count: files.length });
    } catch (error) { await this.failure(error); throw error; }
  }
  get coordinatorId() { return this.config.agentId; }
  ownsRun(run) { return Boolean(this.config.allowedUserIds?.includes(this.context?.source(run)?.userid)); }
  activity() {
    return { id:this.id, connection:this.status.connection, initialized:Boolean(this.completions),
      ready:this.status.connection==='authenticated' && Boolean(this.status.sharedMemory), readyAt:this.status.authenticatedAt ?? null,
      conversations:this.worker?.active.size ?? 0, deliveries:Number(Boolean(this.outbox?.running)), callbacks:this.pendingCallbacks };
  }
  resume() {
    if (this.status.connection==='authenticated') {
      void this.ready.then(() => { this.outbox.paused=false; void this.outbox.resume(); void this.worker.resume(); })
        .catch(error => this.failure(error));
    }
  }
  async close() {
    this.closing = true; this.client.disconnect();
    await this.ready; await this.messageQueue; await this.worker.close();
    await this.completions.close();
    if (this.network.userReply === this.onUserReply) this.network.userReply = null;
    await this.outbox.close();
    if (this.network.userContext === this.context) this.network.userContext = null;
    await this.context.memory.writes;
    if (this.network.gate?.channel === this) this.network.gate.channel = null;
    if (this.network.catalog?.channel === this) this.network.catalog.channel = null;
    this.client.disconnect(); await this.update({ connection: 'stopped' });
  }
}

export async function startChannel(network) {
  const local = resolve(network.root, '.local');
  const config = await readJson(resolve(local, 'wecom.json'));
  if (!config.botId || !config.secret) throw new Error('Configure .local/wecom.json with botId and secret');
  config.agentId ??= network.members.coordinator();
  if (!config.agentId || !network.catalog.get(config.agentId)?.manager) throw new Error('Configure a valid coordinator for the WeCom bridge');
  if (!config.allowedUserIds?.length && !config.pairingCode) {
    config.pairingCode = randomBytes(4).toString('hex').toUpperCase();
    await writeJson(resolve(local, 'wecom.json'), config);
  }
  const WSClient = AiBot.WSClient ?? AiBot.default?.WSClient;
  const client = new WSClient({ botId: config.botId, secret: config.secret, maxReconnectAttempts: 10,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  return new WecomBridge(network, client, config).start();
}
