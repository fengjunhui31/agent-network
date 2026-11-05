import { resolve } from 'node:path';
import { startConfiguredChannel } from './channels.mjs';
import { startServer } from './server.mjs';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { INSTANCE_ROOT, ROOT, LOCAL, readJson } from './paths.mjs';
import { readFile } from 'node:fs/promises';

const [command = 'help', ...args] = process.argv.slice(2);
const value = name => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
const files = args.flatMap((arg, index) => arg === '--file' ? [args[index + 1]] : []);
async function rpc(method, body) {
  const endpoint = await readJson(resolve(LOCAL, 'server.json'));
  const response = await fetch(`${endpoint.url}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(35000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
try {
  if (command === 'serve') {
    if (ROOT === INSTANCE_ROOT && (existsSync(resolve(ROOT, 'current')) || existsSync(resolve(LOCAL, 'release-pending.json')))) {
      execFileSync(process.execPath, [resolve(ROOT, 'scripts/release.mjs'), 'start', INSTANCE_ROOT], { stdio: 'inherit' });
      process.exit(0);
    }
    const channelId = value('channel') ?? (args.includes('--wecom') ? 'wecom' : undefined);
    const service = await startServer({
      port: Number(value('port') ?? 0),
      hold: args.includes('--hold'),
      startChannel: network => startConfiguredChannel(network, channelId),
    });
    console.log(`Local agent network: ${service.endpoint.url}`);
    const shutdown = async () => { await service.close(); process.exit(0); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } else if (command === 'list') {
    console.log(JSON.stringify(await rpc('catalog', {}), null, 2));
  } else if (command === 'team') {
    const patch = {};
    for (const key of ['name', 'runtime', 'model']) if (value(key)) patch[key] = value(key);
    if (value('instructions-file')) patch.instructions = await readFile(value('instructions-file'), 'utf8');
    if (value('capabilities')) patch.capabilities = value('capabilities').split(',').map(x => x.trim()).filter(Boolean);
    console.log(JSON.stringify(await rpc('team', { action: args[0] ?? 'status', template: value('template'),
      id: value('agent') ?? value('id'), patch, from: process.env.LAN_AGENT_ID, fromSessionKey: process.env.LAN_SESSION_KEY || undefined }), null, 2));
  } else if (command === 'run') {
    console.log(JSON.stringify(await rpc('delegate', { target: value('agent'), message: value('message'), files }), null, 2));
  } else if (command === 'send') {
    console.log(JSON.stringify(await rpc('message', { to: value('agent'), message: value('message'), from: 'user', files }), null, 2));
  } else if (command === 'result') {
    console.log(JSON.stringify(await rpc('result', { runId: args[0], waitMs: Number(value('wait') ?? 0) }), null, 2));
  } else console.log('Commands: serve | list | team status/create/update | run --agent ID --message TEXT [--file ABS_PATH] | send --agent ID --message TEXT [--file ABS_PATH] | result RUN_ID [--wait 30000]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
