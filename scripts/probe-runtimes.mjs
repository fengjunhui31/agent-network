import { resolve } from 'node:path';
import { Catalog } from '../src/catalog.mjs';
import { AcpRuntime } from '../src/runtime-acp.mjs';
import { INSTANCE_ROOT, writeJson } from '../src/paths.mjs';
import { startServer } from '../src/server.mjs';

const service = await startServer({ saveEndpoint: false });
const reports = [];
try {
  for (const template of ['researcher', 'engineer']) {
    const agent = await service.network.catalog.create(template, `probe-${template}-${Date.now()}`);
    await service.network.catalog.prepare(agent);
    const runtime = new AcpRuntime(agent, service.endpoint, () => {}, { credentials: {
      NEW_API_URL: 'http://127.0.0.1:1', NEW_API_KEY: 'offline-protocol-probe-not-a-real-key',
      GLM_MODEL: 'glm-5', DEEPSEEK_MODEL: 'deepseek-flash',
    } });
    try {
      await runtime.start();
      reports.push({ runtime: agent.runtime, passed: true, versions: runtime.config.installation.packages,
        initialized: runtime.initialized, sessionId: runtime.sessionId, modelInferenceTested: false });
    } catch (error) {
      reports.push({ runtime: agent.runtime, passed: false, error: error.message, stderr: runtime.stderr, modelInferenceTested: false });
    } finally { runtime.stop(); }
    console.log(JSON.stringify(reports.at(-1), null, 2));
  }
} finally { await service.close(); }
await writeJson(resolve(INSTANCE_ROOT, 'verification', 'protocol-probes.json'), { date: new Date().toISOString(), reports });
if (reports.some(x => !x.passed)) process.exitCode = 1;
