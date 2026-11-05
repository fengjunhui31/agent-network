import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROOT, INSTANCE_ROOT, readJson, writeJson } from '../src/paths.mjs';
import { startServer } from '../src/server.mjs';
import { AgentNetwork } from '../src/network.mjs';

const tag = `models-${Date.now()}`;
const root = resolve(INSTANCE_ROOT, '.local/verification', tag);
await writeJson(resolve(root, 'network.json'), await readJson(resolve(ROOT, 'network.example.json')));
const service = await startServer({ network: await AgentNetwork.create({ root }), saveEndpoint: false });
const report = { startedAt: new Date().toISOString(), mode: 'real-model', cases: [], passed: true };
try {
  for (const model of Object.keys(service.network.catalog.config.models)) {
    const results = await Promise.allSettled(['claude', 'dsh'].map(async runtime => {
      const agent = await service.network.catalog.create('engineer', undefined, false, { runtime, model });
      const nonce = crypto.randomUUID();
      const run = await service.network.delegate({ target: agent.id, timeoutMs: 180000,
        message: `这是兼容性验证。使用原生命令工具在自己的工作目录创建 model-probe.txt，内容严格为 ${nonce}。再读回核对。最后只回答 MODEL_OK，不调用其他员工。` });
      let result;
      do { result = await service.network.getResult(run.runId, 30000); } while (result.status === 'running');
      assert.equal(result.status, 'completed', result.error);
      assert.equal((await readFile(resolve(agent.workspace, 'model-probe.txt'), 'utf8')).trim(), nonce);
      assert.ok(result.answer.includes('MODEL_OK'));
      return { runtime, model, passed: true, runId: run.runId, nonce, workspace: agent.workspace, versions: result.versions };
    }));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const entry = result.status === 'fulfilled' ? result.value : { runtime: ['claude', 'dsh'][i], model, passed: false, error: result.reason.message };
      report.cases.push(entry); if (!entry.passed) report.passed = false;
      console.log(JSON.stringify(entry));
    }
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.runs = [...service.network.runs.values()].map(run => service.network.snapshot(run));
  await service.close(); await writeJson(resolve(INSTANCE_ROOT, 'verification', `${tag}.json`), report);
}
if (!report.passed) process.exitCode = 1;
