import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, INSTANCE_ROOT, readJson, writeJson, redact } from '../../../src/paths.mjs';
import { AgentNetwork } from '../../../src/network.mjs';
import { startServer } from '../../../src/server.mjs';
import { WecomBridge } from '../src/wecom.mjs';

const tag = `replies-${Date.now()}`;
const report = { startedAt: new Date().toISOString(), mode: 'real CLI, model and MCP; recording WeCom transport', cases: [], passed: true };
for (const runtime of ['claude', 'dsh']) {
  const root = resolve(INSTANCE_ROOT, '.local/verification', tag, runtime);
  const config = await readJson(resolve(ROOT, 'network.example.json'));
  const model = config.agents[config.coordinatorId].model ?? config.templates.coordinator.model;
  config.agents = { assistant: { template: 'coordinator', runtime, model } };
  await writeJson(resolve(root, 'network.json'), config);
  const service = await startServer({ network: await AgentNetwork.create({ root }), saveEndpoint: false });
  const output = resolve(service.network.catalog.get('assistant').workspace, 'reply-proof.txt');
  const messages = [];
  class Client extends EventEmitter {
    connect() { this.emit('authenticated'); }
    disconnect() {}
    async replyStream() { throw new Error('Unexpected automatic receipt'); }
    async sendMessage(chatid, body) {
      messages.push({ chatid, content: body.markdown.content, at: new Date().toISOString(),
        agentStillRunning: service.network.isBusy('assistant'), outputExists: await access(output).then(() => true, () => false) });
      return { errcode: 0 };
    }
  }
  const bridge = new WecomBridge(service.network, new Client(), { botId: 'fixture', secret: 'recording-transport',
    agentId: 'assistant', allowedUserIds: ['fixture-owner'] }, {
    configFile: resolve(root, 'wecom.json'), statusFile: resolve(root, 'status.json'), logFile: resolve(root, 'events.jsonl'),
    inboxDirectory: resolve(root, 'inbox'),
  }).start();
  const nonce = crypto.randomUUID();
  const entry = { runtime, model, passed: false, messages, liveWecomTransport: false };
  try {
    await bridge.ready;
    await bridge.receive({ headers: { req_id: crypto.randomUUID() }, body: { msgid: crypto.randomUUID(),
      from: { userid: 'fixture-owner' }, chattype: 'group', chatid: 'fixture-group', msgtype: 'text', text: {
        content: `@ExampleBot 这是主动回复能力验证。按顺序完成：1. 立刻调用 local-network 的 reply_user，message 严格为 FIRST:${nonce}。2. 工具返回后才用原生命令在你的工作目录创建 reply-proof.txt，内容严格为 ${nonce}，读回核对。3. 再调用 reply_user，message 严格为 SECOND:${nonce}。4. 最终内部回答只写 INTERNAL_ONLY:${nonce}。不要委派，不要发送其他消息，不要在最终回答列出文件路径。`,
      } } });
    let item;
    for (let i = 0; i < 180; i++) {
      item = [...bridge.inbox.items.values()][0];
      if (['completed', 'failed'].includes(item?.status)) break;
      await delay(1000);
    }
    assert.equal(item?.status, 'completed', item?.error ?? 'Timed out');
    const run = await service.network.getResult(item.runId);
    assert.equal((await readFile(output, 'utf8')).trim(), nonce);
    assert.deepEqual(messages.map(x => x.content), [`FIRST:${nonce}`, `SECOND:${nonce}`]);
    assert.ok(messages.every(x => x.chatid === 'fixture-group' && x.agentStillRunning));
    assert.equal(messages[0].outputExists, false); assert.equal(messages[1].outputExists, true);
    assert.match(run.answer, new RegExp(`INTERNAL_ONLY:${nonce}`));
    assert.equal(bridge.outbox.forRun(run.runId).filter(x => x.origin === 'tool' && x.status === 'sent').length, 2);
    Object.assign(entry, { passed: true, runId: run.runId, sessionId: run.sessionId, firstReplyBeforeWork: true,
      bothRepliesBeforeCompletion: true, finalInternalTextNotSent: true, versions: run.versions });
  } catch (error) { entry.error = redact(error.message); report.passed = false; }
  finally {
    entry.runs = [...service.network.runs.values()].map(run => service.network.snapshot(run));
    await bridge.close(); await service.close(); await bridge.worker.running; await bridge.statusQueue;
    report.cases.push(entry); console.log(JSON.stringify({ runtime, model, passed: entry.passed, error: entry.error }));
  }
}
report.finishedAt = new Date().toISOString();
await writeJson(resolve(INSTANCE_ROOT, 'verification', `${tag}.json`), report);
console.log(JSON.stringify({ passed: report.passed, report: `verification/${tag}.json` }));
if (!report.passed) process.exitCode = 1;
