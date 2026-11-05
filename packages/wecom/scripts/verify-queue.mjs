import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, INSTANCE_ROOT, readJson, writeJson } from '../../../src/paths.mjs';
import { AgentNetwork } from '../../../src/network.mjs';
import { startServer } from '../../../src/server.mjs';
import { DurableInbox, QueuedCoordinator } from '../src/durable-inbox.mjs';

if (process.argv[2] === '--worker') {
  const root = process.argv[3];
  const service = await startServer({ network: await AgentNetwork.create({ root }), saveEndpoint: false });
  const inbox = await DurableInbox.open(resolve(root, 'queue')); await inbox.recover(service.network);
  const worker = new QueuedCoordinator(service.network, inbox, {
    maxConcurrent: 1, // Explicitly exercise recovery while another conversation waits for capacity.
    deliver: async (item, run) => {
      if (run.status !== 'completed') throw new Error(run.error ?? run.status);
      await appendFile(resolve(root, 'deliveries.jsonl'), JSON.stringify({ id: item.id, runId: run.runId, status: run.status, at: new Date().toISOString() }) + '\n');
    }, failed: error => { console.error(error.message); },
  });
  let stopping = false;
  process.once('SIGTERM', async () => { stopping = true; await worker.close(); await service.close(); process.exit(0); });
  await worker.kick();
  if (!stopping) { await worker.close(); await service.close(); process.exit(0); }
} else {
  const tag = `queue-${Date.now()}`; const root = resolve(INSTANCE_ROOT, '.local/verification', tag);
  const config = await readJson(resolve(ROOT, 'network.example.json')); config.agents[config.coordinatorId].model = 'glm-5.3-flash';
  await writeJson(resolve(root, 'network.json'), config);
  const catalog = await (await import('../../../src/catalog.mjs')).Catalog.load(root);
  const firstAgent = catalog.get(config.coordinatorId); const secondAgent = catalog.get('claude-worker');
  const inbox = await DurableInbox.open(resolve(root, 'queue'));
  const nonce = crypto.randomUUID();
  const gate = `node -e 'const fs=require("fs");if(!fs.existsSync("started.txt")){fs.writeFileSync("started.txt","started");setTimeout(()=>{},90000)}'`;
  await inbox.add({ messageId: 'first', agentId: firstAgent.id, userid: 'verification', files: [],
    message: `这是恢复验证，不要委派。先使用 shell 执行以下命令并等待，不要后台运行：\n${gate}\n然后把 ${nonce} 写到自己的 resumed.txt，读回核对后回答 QUEUE_RECOVERED。started.txt 已存在时上述命令会立即结束。` });
  await inbox.add({ messageId: 'second', agentId: secondAgent.id, userid: 'verification', files: [],
    message: `这是排队验证，不要委派。用命令在自己的工作目录创建 second.txt，内容为 ${nonce}。读回后回答 SECOND_DONE。` });
  const report = { startedAt: new Date().toISOString(), mode: 'real-model-real-process-restart', transport: 'local delivery recorder; not WeCom', root, passed: false };
  let child;
  const launch = () => {
    const process = spawn(globalThis.process.execPath, [fileURLToPath(import.meta.url), '--worker', root], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; process.stdout.on('data', x => { output += x; }); process.stderr.on('data', x => { output += x; });
    return { process, exited: once(process, 'exit'), output: () => output.slice(-5000) };
  };
  try {
    child = launch();
    const deadline = Date.now() + 150000;
    for (;;) {
      try { await access(resolve(firstAgent.workspace, 'started.txt')); break; } catch {}
      if (Date.now() > deadline || child.process.exitCode !== null) throw new Error(`Real run did not reach interruption point: ${child.output()}`);
      await delay(100);
    }
    child.process.kill('SIGTERM'); await child.exited;
    const interrupted = await DurableInbox.open(resolve(root, 'queue'));
    assert.equal([...interrupted.items.values()].find(x => x.messageId === 'first').status, 'running');
    assert.equal([...interrupted.items.values()].find(x => x.messageId === 'second').status, 'pending');
    console.log('Stopped a real CLI during its command; first entry remains running and second remains pending.');
    child = launch();
    const timer = setTimeout(() => child.process.kill('SIGTERM'), 240000);
    const [code] = await child.exited; clearTimeout(timer); assert.equal(code, 0, child.output());
    const recovered = await DurableInbox.open(resolve(root, 'queue'));
    const items = [...recovered.items.values()].sort((a, b) => a.sequence - b.sequence);
    assert.deepEqual(items.map(x => x.status), ['completed', 'completed']); assert.equal(items[0].attempts, 2);
    assert.equal((await readFile(resolve(firstAgent.workspace, 'resumed.txt'), 'utf8')).trim(), nonce);
    assert.equal((await readFile(resolve(secondAgent.workspace, 'second.txt'), 'utf8')).trim(), nonce);
    const deliveries = (await readFile(resolve(root, 'deliveries.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(deliveries.map(x => x.id), items.map(x => x.id));
    Object.assign(report, { passed: true, nonce, entries: items.map(({ id, agentId, status, attempts, recovered, runId }) => ({ id, agentId, status, attempts, recovered, runId })), deliveries });
    console.log('PASS real process restart: interrupted task resumed, next task followed, both file contents verified.');
  } catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
  finally {
    if (child?.process.exitCode === null) { child.process.kill('SIGTERM'); await child.exited; }
    report.finishedAt = new Date().toISOString(); await writeJson(resolve(INSTANCE_ROOT, 'verification', `${tag}.json`), report);
  }
}
