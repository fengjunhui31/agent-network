import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ROOT, INSTANCE_ROOT, LOCAL, readJson, writeJson } from '../src/paths.mjs';

async function current() {
  const endpoint = await readJson(resolve(LOCAL, 'server.json'), null);
  if (!endpoint) return null;
  try {
    const response = await fetch(`${endpoint.url}/catalog`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, body: '{}', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    return endpoint;
  } catch { return null; }
}
const action = process.argv[2] ?? 'status';
const managed = existsSync(resolve(INSTANCE_ROOT, 'current')) || existsSync(resolve(LOCAL, 'release-pending.json'));
if (managed && ['start', 'stop', 'restart', 'restart-worker'].includes(action)) {
  const command = action === 'restart-worker' ? 'restart' : action;
  const args = [resolve(ROOT, 'scripts/release.mjs'), command, INSTANCE_ROOT];
  if (action === 'restart') {
    const log = await open(resolve(LOCAL, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, args, { cwd: INSTANCE_ROOT, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref(); await log.close();
    console.log(`Restart scheduled with drain (supervisor PID ${child.pid})`);
  } else {
    const { stdout } = await promisify(execFile)(process.execPath, args, { cwd: INSTANCE_ROOT });
    console.log(stdout.trim());
  }
  process.exit(0);
}
const active = await current();
if (action === 'status') {
  const channel=await readJson(resolve(LOCAL,'channel.json'),{enabled:false});
  console.log(JSON.stringify({running:Boolean(active),pid:active?.pid,url:active?.url,channel},null,2));
} else if (action === 'restart') {
  const log = await open(resolve(LOCAL, 'service.log'), 'a', 0o600);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'LAN_INSTANCE_ROOT' || !/^(LAN_|ANTHROPIC_|CLAUDE_|DSH_|DEEPSEEK_)/.test(key)));
  const child = spawn(process.execPath, [resolve(ROOT, 'scripts/service.mjs'), 'restart-worker'], {
    cwd: ROOT, detached: true, stdio: ['ignore', log.fd, log.fd], env,
  });
  child.unref(); await log.close(); console.log(`Restart scheduled (supervisor PID ${child.pid}); unfinished queue entries will resume.`);
} else if (action === 'restart-worker') {
  await delay(1000);
  const run = promisify(execFile);
  for (const step of ['stop', 'start']) {
    const result = await run(process.execPath, [resolve(ROOT, 'scripts/service.mjs'), step], { cwd: ROOT });
    console.log(result.stdout.trim());
  }
} else if (action === 'start') {
  if (active) throw new Error(`Service already running (PID ${active.pid})`);
  await mkdir(LOCAL, { recursive: true, mode: 0o700 });
  const log = await open(resolve(LOCAL, 'service.log'), 'a', 0o600);
  const child = spawn(process.execPath, [resolve(ROOT, 'src/cli.mjs'), 'serve'], {
    cwd: ROOT, detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
  });
  child.unref(); await log.close();
  await writeJson(resolve(LOCAL, 'service-process.json'), { pid: child.pid, startedAt: new Date().toISOString() });
  let ready;
  for (let i = 0; i < 40; i++) { ready = await current(); if (ready) break; await delay(250); }
  if (!ready) throw new Error('Service did not start; inspect .local/service.log');
  console.log(`Started local network (PID ${ready.pid}).`);
} else if (action === 'stop') {
  if (!active) console.log('Service is not running.');
  else {
    process.kill(active.pid, 'SIGTERM');
    for (let i = 0; i < 40 && await current(); i++) await delay(250);
    if (await current()) throw new Error('Service has not stopped yet');
    console.log('Stopped local network.');
  }
} else throw new Error('Commands: start | stop | restart | status');
