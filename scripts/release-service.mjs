import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const now = () => new Date().toISOString();
export async function read(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}
export async function save(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}
export function envFor(instance) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(LAN_|CLAUDE_|ANTHROPIC_|DSH_|DEEPSEEK_|WECOM_)/.test(k))
  );
  return { ...env, LAN_INSTANCE_ROOT: instance };
}
export async function rpc(ep, path, body) {
  const url = new URL(ep.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error('Expected the local instance endpoint');
  const response = await fetch(new URL(path, url), {
    method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(3000),
    headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error('Instance request ' + path + ' returned HTTP ' + response.status);
  return response.json();
}
export async function endpoint(instance) {
  const ep = await read(join(instance, '.local/server.json'), null);
  if (!ep) return null;
  try {
    await rpc(ep, '/catalog', {});
    return ep;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'TimeoutError') return null;
    throw error;
  }
}
export async function control(instance, ep, action) {
  const key = await read(join(instance, '.local/release-control.json'));
  if (key.pid !== ep.pid || key.url !== ep.url)
    throw new Error('Control credential does not belong to the running process');
  return rpc(key, '/maintenance', { action });
}
function linuxProcess(pid) {
  try {
    const raw = readFileSync('/proc/' + pid + '/stat', 'utf8');
    // Parenthesized process names can contain spaces or closing parentheses.
    const [state, parent] = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { state, parent: Number(parent) };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid service PID');
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform === 'linux') {
    const info = linuxProcess(pid);
    return Boolean(info && info.state !== 'Z' && info.state !== 'X');
  }
  const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout?.trim();
  return Boolean(state && !state.startsWith('Z'));
}
async function terminate(pid, timeout) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  const deadline = performance.now() + timeout;
  while (alive(pid)) {
    if (performance.now() >= deadline)
      throw new Error('Service is still shutting down; the instance remains owned');
    await delay(100);
  }
}
export async function stop(instance, pid) {
  if (!alive(pid)) return;
  if ((await read(join(instance, '.local/server.lock'), null))?.pid !== pid)
    throw new Error('Service PID no longer owns the instance lock');
  await terminate(pid, 30000);
}
export async function stopUnready(instance, application, eventStart) {
  const child = await read(join(instance, '.local/service-process.json'), null);
  if (
    !child ||
    child.applicationRoot !== application ||
    Date.parse(child.startedAt) < Date.parse(eventStart) ||
    !alive(child.pid)
  )
    return;
  if ((await read(join(instance, '.local/server.lock'), null))?.pid === child.pid)
    return stop(instance, child.pid);
  const script = join(application, 'src/cli.mjs');
  const matches =
    process.platform === 'linux'
      ? readFileSync('/proc/' + child.pid + '/cmdline', 'utf8')
          .split('\0')
          .some((arg, i, args) => arg === script && args[i + 1] === 'serve')
      : (
          spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? ''
        ).includes(script + ' serve');
  if (!matches) throw new Error('Unready process identity changed');
  await terminate(child.pid, 15000);
}
export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
export async function configuredChannel(instance) {
  const config = await read(join(instance, '.local/channel.json'), null);
  if (config) return config.enabled ? config.id : null;
  return (await exists(join(instance, '.local/wecom.json'))) ? 'wecom' : null;
}
export async function detached(script, args, cwd, env, logfile) {
  const log = await open(logfile, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', log.fd, log.fd]
    });
    await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('spawn', done);
    });
    child.unref();
    return child.pid;
  } finally {
    await log.close();
  }
}
export async function start(instance, release, channel) {
  if (await endpoint(instance)) throw new Error('The instance already has a running service');
  const lock = await read(join(instance, '.local/server.lock'), null);
  if (lock && alive(lock.pid)) throw new Error('Another service is starting or shutting down');
  const args = ['serve'];
  if (release.protocol) args.push('--hold');
  if (channel) {
    if (await exists(join(release.directory, 'src/channels.mjs'))) args.push('--channel', channel);
    else if (channel === 'wecom') args.push('--wecom');
    else throw new Error('Legacy application cannot start the selected channel');
  }
  const startedAt = now();
  const pid = await detached(
    join(release.directory, 'src/cli.mjs'),
    args,
    release.directory,
    envFor(instance),
    join(instance, '.local/service.log')
  );
  await save(join(instance, '.local/service-process.json'), {
    pid,
    startedAt,
    applicationRoot: release.directory
  });
  return { pid, startedAt };
}
export async function waitReady(instance, release, processInfo, channel, timeout = 35000) {
  const { pid, startedAt } = processInfo,
    modern = await exists(join(release.directory, 'src/channels.mjs'));
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (!alive(pid)) throw new Error('Candidate exited before becoming ready; see the instance service.log');
    const ep = await endpoint(instance);
    if (ep?.pid === pid) {
      const health = await rpc(ep, '/health');
      if (health.ok !== true || health.version !== release.version || health.buildId !== release.buildId)
        throw new Error('Running health identity differs from the expected release');
      const team = await rpc(ep, '/team', { action: 'status' });
      if (
        team.networkRoot !== release.directory ||
        team.instanceRoot !== instance ||
        team.networkSkill.revision !== release.guideRevision
      )
        throw new Error('Running instance, application or guide differs from the release');
      const gate = release.protocol ? await control(instance, ep, 'status') : {};
      if (release.protocol && gate.phase !== 'holding')
        throw new Error('Candidate started without its admission gate held');
      let readyAt = null;
      if (channel) {
        const status = modern
          ? gate.channelInfo
          : await read(join(instance, '.local/wecom-status.json'), null);
        const ready = modern
          ? status?.id === channel && status.ready
          : channel === 'wecom' && status?.connection === 'authenticated' && status.sharedMemory;
        readyAt = modern ? status?.readyAt : status?.authenticatedAt;
        if (!ready || !(Date.parse(readyAt) >= Date.parse(startedAt))) {
          await delay(120);
          continue;
        }
      }
      return {
        ep,
        service: {
          pid,
          health,
          applicationRoot: team.networkRoot,
          instanceRoot: instance,
          channel: channel || null,
          channelReadyAt: readyAt,
          wecomAuthenticatedAt: channel === 'wecom' ? readyAt : null
        }
      };
    }
    await delay(120);
  }
  throw new Error('Timed out waiting for the expected release and channel');
}
async function legacyIdle(instance, ep) {
  if ((await rpc(ep, '/health')).version !== '0.2.0')
    throw new Error('Only the verified 0.2.0 baseline supports a legacy handoff');
  const hasChildren =
    process.platform === 'linux'
      ? readdirSync('/proc').some((n) => /^\d+$/.test(n) && linuxProcess(Number(n))?.parent === ep.pid)
      : spawnSync('ps', ['-axo', 'ppid='], { encoding: 'utf8' })
          .stdout.trim()
          .split(/\s+/)
          .includes(String(ep.pid));
  if (hasChildren) return false;
  for (const [name, finished] of [
    ['wecom-inbox', ['completed', 'failed', 'cancelled', 'canceled']],
    ['wecom-outbox', ['sent']]
  ]) {
    const dir = join(instance, '.local', name);
    if (!(await exists(dir))) continue;
    for (const file of await readdir(dir))
      if (file.endsWith('.json') && !finished.includes((await read(join(dir, file))).status)) return false;
  }
  return true;
}
export async function drain(instance, ep, supported, seconds) {
  if (supported) await control(instance, ep, 'drain');
  const deadline = performance.now() + seconds * 1000;
  let quiet;
  while (performance.now() < deadline) {
    if (supported) {
      const status = await control(instance, ep, 'status');
      if (status.readyToStop)
        return { mode: 'gated', activeRuns: status.activeRuns, conversations: status.conversations };
    } else if (await legacyIdle(instance, ep)) {
      quiet ??= performance.now();
      if (performance.now() - quiet >= 2000) return { mode: 'legacy-quiet-window', nativeChildren: 0 };
    } else quiet = undefined;
    await delay(180);
  }
  throw new Error('Active work did not finish before the drain timeout');
}
