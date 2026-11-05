// Codex reaches its model through the local ChatGPT login, so the shared mock
// gateway cannot stand in for it. Verify the integration surface this product
// owns instead: the adapter starts, ACP negotiates, and the three message
// injection hooks load and become trusted for this member's workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { runtimeConfig, runtimeInstallation } from '../src/runtime-config.mjs';

const root = await mkdtemp(resolve(tmpdir(), 'codex-verify-'));
const id = `verify-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
const agent = {
  id, runtime: 'codex', model: 'gpt-6.1-sol',
  workspace: resolve(root, 'workspace'), configDirectory: resolve(root, 'config'), capabilities: [],
};
await mkdir(agent.workspace, { recursive: true });
await mkdir(agent.configDirectory, { recursive: true });
let child;
try {
  const installation = await runtimeInstallation('codex');
  const config = await runtimeConfig(agent, { url: 'http://127.0.0.1:1', token: 'local-verification-only' });
  child = spawn(config.bin, config.args, { cwd: agent.workspace, env: config.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const pending = new Map(); let next = 1;
  createInterface({ input: child.stdout }).on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    pending.get(frame.id)?.(frame);
  });
  const call = (method, params, timeoutMs = 45000) => new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), timeoutMs);
    pending.set(++next - 1, frame => { clearTimeout(timer); settle(frame); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id: next - 1 }) + '\n');
  });
  const initialized = await call('initialize', {
    protocolVersion: 1, clientInfo: { name: 'local-agent-network', version: '1' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  assert.ok(initialized.result, `ACP initialize failed: ${JSON.stringify(initialized.error ?? {})} ${stderr}`);
  const listed = await call('_codex/hooks/list', { cwd: agent.workspace });
  const hooks = listed.result?.hooks ?? [];
  const events = new Set(hooks.map(hook => hook.eventName));
  for (const event of ['userPromptSubmit', 'postToolUse', 'stop']) assert.ok(events.has(event), `Codex did not load the ${event} hook`);
  const trusted = await call('_codex/hooks/trust', { cwd: agent.workspace, hooks: hooks.map(({ key, currentHash }) => ({ key, currentHash })) });
  assert.equal(trusted.result?.trusted, true, `Codex refused hook trust: ${JSON.stringify(trusted.error ?? trusted.result)}`);
  console.log(`PASS codex ${installation.slot}: ACP negotiated, ${[...events].join('/')} hooks trusted`);
} catch (error) {
  console.error(`FAIL codex: ${error.message}`); process.exitCode = 1;
} finally {
  if (child?.exitCode === null) child.kill('SIGTERM');
  await rm(root, { recursive: true, force: true });
}
