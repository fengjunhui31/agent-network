import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentNetwork } from '../src/network.mjs';
import { Catalog } from '../src/catalog.mjs';
import { startServer } from '../src/server.mjs';
import { INSTANCE_ROOT, writeJson } from '../src/paths.mjs';
import { executionKey } from '../src/sessions.mjs';
export async function fixture(t) {
  const base = resolve(INSTANCE_ROOT, '.local', 'tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'network-'));
  await writeJson(resolve(root, 'network.json'), {
    workspaceRoot: '.local/workspaces', templates: { worker: { runtime: 'fake', capabilities: ['test'], instructions: 'test' } },
    agents: { a: { template: 'worker' }, b: { template: 'worker' } },
  });
  const controls = new Map();
  class FakeRuntime {
    constructor(agent, endpoint, emit) { this.agent = agent; this.emit = emit; this.readableFiles = new Set(); controls.set(executionKey(agent.id, agent.sessionKey), this); }
    async start() {}
    async run(message) { this.lastMessage = message; this.emit({ sessionUpdate: 'tool_call', title: 'test-tool' }); return new Promise(resolve => { this.finish = resolve; }); }
    async cancel() { this.finish?.({ answer: '', stopReason: 'cancelled' }); }
    stop() { void this.cancel(); }
  }
  const network = new AgentNetwork(await Catalog.load(root), { root, runtimeFactory: (...args) => new FakeRuntime(...args) });
  const service = await startServer({ network, saveEndpoint: false });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { network, service, controls, root };
}
