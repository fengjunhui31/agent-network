import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import { runtimeConfig } from './runtime-config.mjs';
import { readJson, writeJson, within, redact } from './paths.mjs';
import { guideFiles } from './network-guide.mjs';
import { networkVersion } from './version.mjs';

function isProgress(update, seen) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return update.content?.type === 'text' ? Boolean(update.content.text?.trim()) : Boolean(update.content);
    case 'tool_call':
    case 'tool_call_update': {
      if (!update.toolCallId) return false;
      const previous = seen.get(update.toolCallId);
      const fields = previous ?? new Map();
      seen.set(update.toolCallId, fields);
      let changed = !previous && update.sessionUpdate === 'tool_call';
      for (const key of ['status', 'title', 'content', 'rawInput', 'rawOutput', 'locations']) {
        if (update[key] == null) continue;
        const digest = createHash('sha256').update(JSON.stringify(update[key])).digest('hex');
        if (fields.get(key) !== digest) { fields.set(key, digest); changed = true; }
      }
      return changed;
    }
    case 'plan': {
      if (!update.entries?.length) return false;
      const digest = createHash('sha256').update(JSON.stringify(update.entries)).digest('hex');
      const changed = seen.get(null) !== digest;
      seen.set(null, digest);
      return changed;
    }
    default:
      return false;
  }
}

export class AcpRuntime {
  constructor(agent, endpoint, onEvent, { credentials } = {}) {
    this.agent = agent; this.endpoint = endpoint; this.onEvent = onEvent; this.current = null; this.credentialsOverride = credentials;
  }
  async start() {
    this.config = await runtimeConfig(this.agent, this.endpoint, this.credentialsOverride);
    const { bin, args, env } = this.config;
    this.child = spawn(bin, args, { cwd: this.agent.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.stderr = '';
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + redact(chunk, this.config.secrets)).slice(-16000); });
    this.child.once('error', error => this.connection?.close(error));
    this.child.once('exit', (code, signal) => {
      this.connection?.close(new Error(`Runtime exited: ${code ?? signal}; ${this.stderr.slice(-3000)}`));
    });
    const app = client()
      .onNotification('session/update', ({ params }) => this.update(params))
      .onRequest('session/request_permission', ({ params }) => {
        const option = params.options.find(x => x.kind === 'allow_once');
        return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
      })
      .onRequest('fs/read_text_file', async ({ params }) => {
        this.checkPath(params.path);
        const content = await readFile(params.path, 'utf8');
        const start = Math.max(0, (params.line ?? 1) - 1);
        return { content: content.split('\n').slice(start, params.limit ? start + params.limit : undefined).join('\n') };
      })
      .onRequest('fs/write_text_file', async ({ params }) => {
        this.checkPath(params.path, true);
        await mkdir(dirname(params.path), { recursive: true });
        await writeFile(params.path, params.content);
        return {};
      });
    this.connection = app.connect(ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout)));
    const rpc = this.connection.agent;
    this.initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'local-agent-network', version: networkVersion },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    }, { signal: AbortSignal.timeout(45000) });
    const saved = await readJson(resolve(this.agent.configDirectory, 'session.json'), null);
    const params = { cwd: this.agent.workspace, mcpServers: this.config.mcpServers };
    if (saved?.runtime === this.agent.runtime && (!saved.model || saved.model === this.config.model) && saved?.sessionId) {
      if (this.initialized.agentCapabilities?.loadSession) {
        await rpc.request('session/load', { ...params, sessionId: saved.sessionId }, { signal: AbortSignal.timeout(60000) });
      } else if (this.initialized.agentCapabilities?.sessionCapabilities?.resume) {
        await rpc.request('session/resume', { ...params, sessionId: saved.sessionId }, { signal: AbortSignal.timeout(60000) });
      } else throw new Error('Saved session cannot be resumed by this runtime; create a new member/session explicitly.');
      this.sessionId = saved.sessionId;
    } else {
      const response = await rpc.request('session/new', {
        ...params,
        _meta: this.agent.runtime === 'claude' ? { claudeCode: { options: { model: this.config.model, settingSources: ['project', 'local'] } } } : undefined,
      }, { signal: AbortSignal.timeout(60000) });
      this.sessionId = response.sessionId;
    }
    if (saved?.sessionId && saved.sessionId !== this.sessionId) {
      const historyFile = resolve(this.agent.configDirectory, 'session-history.json');
      const history = await readJson(historyFile, []); history.push(saved); await writeJson(historyFile, history);
    }
    await writeJson(resolve(this.agent.configDirectory, 'session.json'), { runtime: this.agent.runtime, model: this.config.model, sessionId: this.sessionId });
    return this;
  }
  checkPath(path, write = false) {
    const absolute = resolve(path);
    if (!within(this.agent.workspace, absolute) && (write || (!this.readableFiles?.has(absolute) && !guideFiles.includes(absolute)))) {
      throw new Error(`File outside this member's workspace/shared inputs: ${absolute}`);
    }
  }
  update({ sessionId, update }) {
    // Loading a saved session may replay old tools. Only the current prompt can renew its timer.
    if (!this.current || sessionId !== this.sessionId) return;
    if (this.progressSeen && isProgress(update, this.progressSeen)) this.onProgress();
    if (update.sessionUpdate === 'agent_thought_chunk') return;
    this.onEvent({ ...update, sessionId });
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      this.current.push(update.content.text);
    }
  }
  async run(message, files = [], timeoutMs, idleTimeoutMs) {
    // Numeric timeoutMs keeps the existing absolute deadline for CLI and worker callers.
    const absoluteMs = timeoutMs ?? (idleTimeoutMs == null ? 300000 : undefined);
    for (const duration of [absoluteMs, idleTimeoutMs === 0 ? undefined : idleTimeoutMs]) {
      if (duration != null && (!Number.isSafeInteger(duration) || duration < 1 || duration > 2147483647)) {
        throw new Error('Execution timeout must be a positive timer duration in milliseconds');
      }
    }
    this.current = [];
    this.readableFiles = new Set(files.map(x => resolve(x)));
    const prompt = [{ type: 'text', text: message }];
    if (files.length) prompt.push({ type: 'text', text: `共享输入文件（本机绝对路径）：\n${files.join('\n')}` });
    let deadline, idle, grace, cancellation;
    let lastProgressAt = new Date().toISOString();
    this.cancelTurn = (source, limitMs) => {
      if (cancellation) return Promise.resolve();
      cancellation = { source, requestedAt: new Date().toISOString(), ...(limitMs != null ? { limitMs } : {}) };
      if (source === 'idle_timeout') cancellation.lastProgressAt = lastProgressAt;
      clearTimeout(deadline); clearTimeout(idle);
      grace = setTimeout(() => this.stop(), 10000);
      return this.connection.agent.notify('session/cancel', { sessionId: this.sessionId }).catch(() => {});
    };
    this.progressSeen = idleTimeoutMs > 0 ? new Map() : null;
    this.onProgress = () => {
      if (!idleTimeoutMs || cancellation) return;
      lastProgressAt = new Date().toISOString();
      clearTimeout(idle);
      idle = setTimeout(() => { void this.cancelTurn('idle_timeout', idleTimeoutMs); }, idleTimeoutMs);
    };
    if (absoluteMs != null) deadline = setTimeout(() => { void this.cancelTurn('deadline', absoluteMs); }, absoluteMs);
    this.onProgress();
    try {
      let stopReason;
      try {
        ({ stopReason } = await this.connection.agent.request('session/prompt', { sessionId: this.sessionId, prompt }));
      } catch (error) {
        if (!cancellation) throw error;
        stopReason = 'cancelled'; // The grace stop can close the stream before the adapter replies.
      }
      if (stopReason === 'cancelled' && !cancellation) {
        cancellation = { source: 'runtime_unspecified', observedAt: new Date().toISOString() };
      }
      return { answer: this.current.join(''), stopReason, sessionId: this.sessionId, model: this.config.model,
        versions: this.config.installation.packages, ...(cancellation ? { cancellation } : {}) };
    } finally {
      clearTimeout(deadline); clearTimeout(idle); clearTimeout(grace);
      this.progressSeen = null; this.onProgress = null; this.cancelTurn = null; this.current = null;
    }
  }
  async cancel(source = 'user_stop') {
    await this.cancelTurn?.(source);
  }
  stop() {
    this.connection?.close();
    if (this.child?.pid && this.child.exitCode === null) {
      try { process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, 'SIGTERM'); } catch {}
    }
  }
}
