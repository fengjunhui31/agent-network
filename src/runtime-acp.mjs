import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import { runtimeConfig } from './runtime-config.mjs';
import { readJson, writeJson, within, redact } from './paths.mjs';
import { guideFiles } from './network-guide.mjs';
import { networkVersion } from './version.mjs';

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
      .onNotification('session/update', ({ params }) => {
        const update = params.update;
        if (update.sessionUpdate === 'agent_thought_chunk') return;
        // session/load can replay prior messages and tools. They are history, not current progress.
        if (!this.current) return;
        this.onEvent({ ...update, sessionId: params.sessionId });
        if (this.current && update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          this.current.push(update.content.text);
        }
      })
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
  async run(message, files = [], timeoutMs = 300000) {
    this.current = [];
    this.readableFiles = new Set(files.map(x => resolve(x)));
    const prompt = [{ type: 'text', text: message }];
    if (files.length) prompt.push({ type: 'text', text: `共享输入文件（本机绝对路径）：\n${files.join('\n')}` });
    const timer = setTimeout(() => { void this.cancel(); }, timeoutMs);
    const hardStop = setTimeout(() => this.stop(), timeoutMs + 10000);
    try {
      const result = await this.connection.agent.request('session/prompt', { sessionId: this.sessionId, prompt });
      return { answer: this.current.join(''), stopReason: result.stopReason, sessionId: this.sessionId, model: this.config.model,
        versions: this.config.installation.packages };
    } finally { clearTimeout(timer); clearTimeout(hardStop); this.current = null; }
  }
  async cancel() {
    if (this.connection && this.sessionId) await this.connection.agent.notify('session/cancel', { sessionId: this.sessionId }).catch(() => {});
  }
  stop() {
    this.connection?.close();
    if (this.child?.pid && this.child.exitCode === null) {
      try { process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, 'SIGTERM'); } catch {}
    }
  }
}
