import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { AgentNetwork } from '../src/network.mjs';
import { ROOT, INSTANCE_ROOT, privateEnvironment, readJson, writeJson } from '../src/paths.mjs';

const credentials = await privateEnvironment();
for (const field of ['NEW_API_URL', 'NEW_API_KEY', 'GLM_MODEL', 'DEEPSEEK_MODEL']) {
  if (!credentials[field]) throw new Error(`Live verification requires ${field}; no mock or alternative provider will be substituted.`);
}
const root = resolve(INSTANCE_ROOT, '.local', 'verification', `live-${Date.now()}`);
await writeJson(resolve(root, 'network.json'), await readJson(resolve(ROOT, 'network.example.json')));
const service = await startServer({ network: await AgentNetwork.create({ root }), saveEndpoint: false });
const { network } = service;
const report = { startedAt: new Date().toISOString(), mode: 'real-model', cases: [], injected: [] };
network.on('injected', event => report.injected.push(event));

async function waitResult(runId, maxMs = 240000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const result = await network.getResult(runId, 1000);
    if (result.status !== 'running') return result;
  }
  throw new Error(`Execution did not finish: ${runId}`);
}
async function waitFile(file, runId) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    try { await access(file); return; } catch {}
    const result = await network.getResult(runId);
    if (result.status !== 'running') throw new Error(`Receiver ended before its hook boundary: ${JSON.stringify(result)}`);
    await delay(100);
  }
  throw new Error('Receiver never reached the real shell gate');
}

async function exchange(receiverTemplate, senderTemplate) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const receiver = await network.catalog.create(receiverTemplate, `receive-${receiverTemplate}-${suffix}`);
  const sender = await network.catalog.create(senderTemplate, `send-${senderTemplate}-${suffix}`);
  const nonce = crypto.randomUUID();
  const content = `shared-file-${crypto.randomUUID()}`;
  const file = resolve(sender.workspace, 'shared.txt'); await writeFile(file, content);
  const ready = resolve(receiver.workspace, 'ready.txt');
  const gate = `node -e 'require("fs").writeFileSync("ready.txt","ready");setTimeout(()=>{},12000)'`;
  const receiveRun = await network.delegate({ target: receiver.id, message:
    `这是本机运行时的集成验证。立即使用 shell 执行下面这条命令，不要改成后台执行：\n${gate}\n` +
    '工具结束时会有 hook 注入一条来自其他成员的消息，包含随机 nonce 和一个共享文件路径。读取共享文件，将 {"nonce":"收到的原值","content":"共享文件的完整内容"} 写入当前目录 receipt.json。不要猜测 nonce，不要从其他目录寻找。没有收到消息就再执行一次 sleep 3 检查下个 hook。完成后说明 receipt.json 的绝对路径。', timeoutMs: 180000 });
  await waitFile(ready, receiveRun.runId);
  const sendRun = await network.delegate({ target: sender.id, message:
    `调用 local-network 的 send_message，给 ${receiver.id} 发送内容 "nonce=${nonce}"，files 传 [${JSON.stringify(file)}]。` +
    `然后用 get_result 查询 runId=${receiveRun.runId}，waitMs=30000，直到结束。不要使用 delegate，不要直接写对方文件。最终简述结果。`, timeoutMs: 180000 });
  const [received, sent] = await Promise.all([waitResult(receiveRun.runId), waitResult(sendRun.runId)]);
  assert.equal(received.status, 'completed', received.error);
  assert.equal(sent.status, 'completed', sent.error);
  const receipt = JSON.parse(await readFile(resolve(receiver.workspace, 'receipt.json'), 'utf8'));
  assert.equal(receipt.nonce, nonce); assert.equal(receipt.content.trim(), content);
  const injected = report.injected.find(x => x.agentId === receiver.id && x.event === 'PostToolUse' && x.messages.some(m => m.message.includes(nonce)));
  assert.ok(injected, 'The nonce must arrive through the native PostToolUse hook while the original run is active');
  report.cases.push({ name: `${sender.runtime}-to-${receiver.runtime}`, passed: true, nonce, receipt,
    receiver: { runId: receiveRun.runId, agentId: receiver.id, workspace: receiver.workspace, model: received.model, versions: received.versions },
    sender: { runId: sendRun.runId, agentId: sender.id, workspace: sender.workspace, model: sent.model, versions: sent.versions } });
  console.log(`PASS ${sender.runtime} -> ${receiver.runtime}: native hook + MCP message + shared file + final result`);
}

try {
  if (!process.argv.includes('--delegation-only')) {
    await exchange('engineer', 'researcher');
    await exchange('researcher', 'engineer');
  }
  const assistant = await network.catalog.create('coordinator', `organizer-${Date.now()}`);
  const run = await network.delegate({ target: assistant.id, message:
    '请通过 delegate 向 template:engineer 委派：计算 6*7，将结果 42 写到该成员自己的工作目录 delegation.txt，然后返回文件绝对路径。使用 get_result 取得结果，确认执行完成。你自己不要创建这个文件。', timeoutMs: 180000 });
  const result = await waitResult(run.runId);
  assert.equal(result.status, 'completed', result.error);
  const children = [...network.runs.values()].filter(x => x.from === assistant.id && x.runtime === 'dsh');
  assert.ok(children.length, 'Coordinator must actually create/delegate to a DSH member');
  const child = children.find(x => x.status === 'completed'); assert.ok(child);
  assert.equal((await readFile(resolve(child.workspace, 'delegation.txt'), 'utf8')).trim(), '42');
  report.cases.push({ name: 'autonomous-delegation', passed: true, parentRunId: run.runId, childRunId: child.runId, childWorkspace: child.workspace });
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; process.exitCode = 1; console.error(error.message);
} finally {
  report.finishedAt = new Date().toISOString();
  report.runs = [...network.runs.values()].map(run => network.snapshot(run));
  await service.close();
  await writeJson(resolve(INSTANCE_ROOT, 'verification', `live-${Date.now()}.json`), report);
}
