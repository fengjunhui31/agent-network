import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startMockModel } from './mock-model.mjs';
import { AcpRuntime } from '../src/runtime-acp.mjs';
import { AgentNetwork } from '../src/network.mjs';
import { startServer } from '../src/server.mjs';
import { INSTANCE_ROOT, writeJson } from '../src/paths.mjs';

const selected = process.argv[process.argv.indexOf('--runtime') + 1];
const templates = process.argv.includes('--runtime') ? { claude: ['researcher'], dsh: ['engineer'] }[selected] : ['researcher', 'engineer'];
if (!templates) throw new Error('Use --runtime claude|dsh');
const root = resolve(INSTANCE_ROOT, '.local', 'verification', `native-${Date.now()}`);
// Installation probes use their own employees, independent of the instance's role and template names.
await writeJson(resolve(root, 'network.json'), { workspaceRoot:'workspaces', agents:{}, templates:{
  researcher:{runtime:'claude',model:'glm-hook-test',instructions:'Verify native tools.',capabilities:[]},
  engineer:{runtime:'dsh',model:'deepseek-hook-test',instructions:'Verify native tools.',capabilities:[]},
} });
const service = await startServer({ network: await AgentNetwork.create({ root }), saveEndpoint: false });
const mock = await startMockModel();
const report = { mode: 'real-runtime-mock-model', date: new Date().toISOString(), node: process.version, cases: [], injected: [] };
service.network.on('injected', event => report.injected.push(event));
service.network.runtimeFactory = (...args) => new AcpRuntime(...args, { credentials: {
  NEW_API_URL: mock.url, NEW_API_KEY: 'local-mock-model-only', GLM_MODEL: 'glm-hook-test', DEEPSEEK_MODEL: 'deepseek-hook-test',
} });
try {
  for (const template of templates) {
    const agent = await service.network.catalog.create(template, `native-${template}-${Date.now()}`);
    agent.model = agent.runtime === 'claude' ? 'glm-hook-test' : 'deepseek-hook-test';
    let previousSession; let previousNonce;
    for (const phase of ['new-session', 'resume-session']) {
    await rm(resolve(agent.workspace, 'native-ready.txt'), { force: true });
    const nonce = crypto.randomUUID(); Object.assign(mock.state, { nonce, model: agent.runtime === 'claude' ? 'glm-hook-test' : 'deepseek-hook-test', delivered: false, calls: [], error: undefined, resultRequested: false, resultSeen: false });
    const run = await service.network.delegate({ target: agent.id, message: 'Native hook transport test. Follow the requested tool invocation.', timeoutMs: 60000 });
    mock.state.resultRunId = run.runId;
    const until = Date.now() + 65000; let sent = false;
    while (Date.now() < until) {
      if (!sent) {
        try { await access(resolve(agent.workspace, 'native-ready.txt')); await service.network.send({ to: agent.id, from: 'native-test', message: nonce }); sent = true; } catch {}
      }
      const result = await service.network.getResult(run.runId);
      if (result.status !== 'running') {
        assert.equal(result.status, 'completed', result.error);
        assert.ok(sent, 'Native command did not actually create the gate file');
        assert.match(result.answer, new RegExp(`NATIVE_HOOK_SEEN:${nonce}`));
        assert.ok(mock.state.resultSeen, 'The real runtime must call our MCP get_result tool and consume its response');
        assert.ok(report.injected.some(e => e.agentId === agent.id && e.event === 'PostToolUse' && e.messages.some(m => m.message === nonce)), 'Message must enter at the native tool boundary');
        if (previousSession) assert.equal(result.sessionId, previousSession, 'Restarts must resume the same native session');
        if (previousNonce) assert.ok(!JSON.stringify(result.events).includes(`NATIVE_HOOK_SEEN:${previousNonce}`), 'Session replay must not be emitted as current progress');
        previousSession = result.sessionId;
        previousNonce = nonce;
        const toolNames = mock.state.calls.flatMap(x => x.tools);
        for (const name of ['delegate', 'send_message', 'get_result']) assert.ok(toolNames.some(x => x.endsWith(name)), `Missing MCP tool ${name}`);
        report.cases.push({ runtime: agent.runtime, phase, sessionId: result.sessionId, passed: true, runId: run.runId, modelInferenceTested: false, versions: result.versions, requests: mock.state.calls });
        console.log(`PASS ${agent.runtime} ${phase}: actual CLI/ACP/MCP/native tool/native hook; model response is MOCK`);
        break;
      }
      await delay(100);
    }
    assert.ok(report.cases.some(c => c.runtime === agent.runtime && c.phase === phase), 'Native runtime timed out');
    const runtime = service.network.runtimes.get(agent.id);
    const exited = runtime.child.exitCode === null ? once(runtime.child, 'exit') : Promise.resolve();
    runtime.stop(); service.network.runtimes.delete(agent.id);
    await exited;
    }
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; report.mockError = mock.state.error; report.lastRequests = mock.state.calls;
  report.runtimeDiagnostics = [...service.network.runtimes.entries()].map(([id, runtime]) => ({ id, stderr: runtime.stderr }));
  report.runs = [...service.network.runs.values()].map(x => service.network.snapshot(x));
  console.error(error.message); process.exitCode = 1;
} finally {
  await service.close(); await mock.close();
  await writeJson(resolve(INSTANCE_ROOT, 'verification', `native-${Date.now()}.json`), report);
}
