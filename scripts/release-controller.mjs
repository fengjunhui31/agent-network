import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { hash, layout } from './release-archive.mjs';
import {
  alive,
  configuredChannel,
  control,
  drain,
  endpoint,
  envFor,
  now,
  read,
  rpc,
  save,
  start,
  stop,
  stopUnready,
  waitReady
} from './release-service.mjs';
import { current, point, stage, validate } from './release-store.mjs';
import { withReleaseLock } from './release-lock.mjs';

async function inspect(ep) {
  const team = await rpc(ep, '/team', { action: 'status' });
  const catalog = await rpc(ep, '/catalog', {});
  return {
    pid: ep.pid,
    applicationRoot: team.networkRoot,
    instanceRoot: team.instanceRoot,
    version: team.networkVersion,
    buildId: team.buildId,
    workspaces: Object.fromEntries(catalog.agents.map((agent) => [agent.id, agent.workspace]))
  };
}
function validId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/.test(id))
    throw new Error('Invalid operation ID');
  return id;
}
export class ReleaseController {
  constructor(instance, seconds) {
    this.instance = instance;
    this.seconds = seconds;
    this.local = join(instance, '.local');
    this.journal = join(this.local, 'release-pending.json');
    this.statefile = join(this.local, 'release-state.json');
  }
  folder(id) {
    return join(this.local, 'upgrades', validId(id));
  }
  state() {
    return read(this.statefile, {});
  }
  async record(event, fields = {}) {
    Object.assign(event, fields);
    await save(join(this.folder(event.operationId), 'upgrade-record.json'), event);
  }
  async progress(event, phase, fields) {
    await this.record(event, { ...fields, phase });
    await save(this.journal, { operationId: event.operationId });
  }
  async status() {
    const ep = await endpoint(this.instance);
    return {
      instance: this.instance,
      current: await current(this.instance),
      previous: (await this.state()).previous ?? null,
      running: Boolean(ep),
      health: ep ? await rpc(ep, '/health') : null,
      pendingOperation: (await read(this.journal, null))?.operationId ?? null
    };
  }
  async baseline(archive, folder, old) {
    if (!archive || old.version !== '0.2.0' || old.buildId !== null)
      throw new Error('A source migration requires the matching --bootstrap-from 0.2.0 archive');
    const baseline = await stage(this.instance, archive, folder);
    if (baseline.version !== old.version || old.applicationRoot !== this.instance)
      throw new Error('Legacy application is not the matching source instance');
    const manifest = await read(join(baseline.directory, 'release-manifest.json'));
    for (const [name, digest] of Object.entries(manifest.files)) {
      const source = join(this.instance, name === 'README.md' ? 'docs/INSTALL.md' : name);
      if (hash(await readFile(source)) !== digest)
        throw new Error('Legacy source differs from the rollback archive at ' + name);
    }
    return baseline;
  }
  async launch(release, event) {
    await validate(this.instance, release);
    if (!release.protocol) {
      const prepare =
        "import {Catalog} from './src/catalog.mjs'; const c=await Catalog.load(); for (const id of Object.keys(c.config.agents)) await c.prepare(c.get(id));";
      execFileSync(process.execPath, ['--input-type=module', '-e', prepare], {
        cwd: release.directory,
        env: envFor(this.instance),
        timeout: 15000
      });
    }
    const channel = Object.hasOwn(event, 'channel') ? event.channel : event.wecom ? 'wecom' : null;
    const processInfo = await start(this.instance, release, channel);
    await this.record(event, { startingPid: processInfo.pid });
    const candidate = await waitReady(this.instance, release, processInfo, channel);
    const live = await inspect(candidate.ep);
    for (const [id, path] of Object.entries(event.before?.workspaces ?? {})) {
      if (live.workspaces[id] !== path) throw new Error('An existing agent opened a different workspace');
    }
    return candidate;
  }
  async openGate(release, ep) {
    if (release.protocol && (await control(this.instance, ep, 'resume')).phase !== 'open')
      throw new Error('Dispatch was not resumed');
  }
  async settle(event) {
    const target = await validate(this.instance, event.target);
    if (!equal(await current(this.instance), target))
      throw new Error('Committed release and current pointer differ');
    let ep = await endpoint(this.instance);
    if (!ep) {
      const candidate = await this.launch(target, event);
      ep = candidate.ep;
      await this.record(event, { service: candidate.service });
    }
    const live = await inspect(ep);
    if (live.buildId !== target.buildId || live.applicationRoot !== target.directory)
      throw new Error('Another service occupies the committed instance');
    await this.openGate(target, ep);
    await this.record(event, { status: 'succeeded', phase: 'complete', endedAt: now() });
    await rm(this.journal, { force: true });
  }
  async restore(event) {
    const { previous, before: old, target } = event;
    const ep = await endpoint(this.instance);
    if (ep && old && ep.pid === old.pid) {
      if (previous) await this.openGate(previous, ep);
      return 'original-process-resumed';
    }
    if (ep) {
      const candidate = await inspect(ep);
      if (
        previous &&
        candidate.buildId === previous.buildId &&
        candidate.applicationRoot === previous.directory &&
        equal(await current(this.instance), previous)
      ) {
        await this.openGate(previous, ep);
        return 'previous-release-running';
      }
      if (candidate.applicationRoot !== target.directory)
        throw new Error('Refusing to interrupt an unrelated running application');
      if (target.protocol) await drain(this.instance, ep, true, this.seconds);
      await stop(this.instance, ep.pid);
    } else {
      await stopUnready(this.instance, target.directory, event.startedAt);
      const lock = await read(join(this.local, 'server.lock'), null);
      if (lock && alive(lock.pid)) {
        const processInfo = await read(join(this.local, 'service-process.json'), null);
        if (processInfo?.pid !== lock.pid || processInfo.applicationRoot !== target.directory)
          throw new Error('Instance lock still belongs to another process');
        await stop(this.instance, lock.pid);
      }
    }
    if (previous) {
      await point(this.instance, previous);
      if (old) {
        const restored = await this.launch(previous, event);
        await this.openGate(previous, restored.ep);
        await this.record(event, { restoredService: restored.service });
      }
      if (!equal(event.priorState.current, previous))
        await save(this.statefile, {
          current: previous,
          previous: event.priorState.previous ?? null,
          operationId: null
        });
      return 'previous-application-restored';
    }
    if (equal(await current(this.instance), target)) await rm(join(this.instance, 'current'));
    return 'initial-install-reverted';
  }
  async recover() {
    const pending = await read(this.journal, null);
    if (!pending) return;
    const event = await read(join(this.folder(pending.operationId), 'upgrade-record.json'));
    if ((await this.state()).operationId === pending.operationId) {
      await this.settle(event);
      return;
    }
    const recovery = await this.restore(event);
    await this.record(event, { status: 'failed', phase: 'recovered', recovery, endedAt: now() });
    await rm(this.journal);
  }
  async switch(event, target, bootstrap, restart) {
    const pointer = await current(this.instance),
      state = await this.state();
    if (!equal(pointer, state.current ?? null))
      throw new Error('Active pointer differs from the recorded release state');
    const ep = await endpoint(this.instance),
      old = ep ? await inspect(ep) : null;
    if (
      old &&
      (old.instanceRoot !== this.instance ||
        (pointer && (old.applicationRoot !== pointer.directory || old.buildId !== pointer.buildId)))
    ) {
      throw new Error('Running service differs from this instance or release pointer');
    }
    const previous =
      pointer ?? (old ? await this.baseline(bootstrap, this.folder(event.operationId), old) : null);
    if (equal(pointer, target) && ep && !restart) {
      await this.record(event, {
        status: 'succeeded',
        phase: 'already-current',
        target,
        before: old,
        endedAt: now()
      });
      return;
    }
    await this.progress(event, 'draining', {
      previous,
      before: old,
      target,
      priorState: state,
      channel: await configuredChannel(this.instance)
    });
    if (ep) {
      const result = await drain(this.instance, ep, Boolean(previous.protocol), this.seconds);
      await this.progress(event, 'stopping', { drain: result });
      await stop(this.instance, ep.pid);
    }
    await this.progress(event, 'switching');
    await point(this.instance, target);
    await this.progress(event, 'starting');
    const candidate = await this.launch(target, event);
    await this.progress(event, 'validated', { service: candidate.service });
    await save(this.statefile, {
      current: target,
      previous: equal(target, previous) ? (state.previous ?? null) : previous,
      operationId: event.operationId
    });
    await this.settle(event);
  }
  async stopCurrent(event) {
    const ep = await endpoint(this.instance);
    if (ep) {
      const release = await current(this.instance);
      if (!release) throw new Error('Use the original service command for an unmanaged instance');
      try {
        await this.record(event, {
          drain: await drain(this.instance, ep, Boolean(release.protocol), this.seconds)
        });
        await stop(this.instance, ep.pid);
      } catch (error) {
        if (await endpoint(this.instance)) await this.openGate(release, ep);
        throw error;
      }
    }
    await this.record(event, { status: 'succeeded', phase: 'stopped', endedAt: now() });
  }
  async operate(cmd, archive, bootstrap, id, scheduled = false) {
    const folder = this.folder(id),
      record = join(folder, 'upgrade-record.json');
    await mkdir(join(this.local, 'upgrades'), { recursive: true, mode: 0o700 });
    if (!scheduled) await mkdir(folder, { mode: 0o700 });
    const initial = scheduled ? await read(record) : null;
    if (scheduled && (initial.status !== 'scheduled' || initial.archive !== archive))
      throw new Error('Operation ID has already been used');
    const event = {
      schemaVersion: 1,
      operationId: id,
      action: cmd,
      startedAt: initial?.startedAt ?? now(),
      status: 'preparing',
      stateLayout: layout
    };
    try {
      await withReleaseLock(this.instance, async () => {
        await this.record(event);
        await this.recover();
        if (cmd === 'recover')
          return this.record(event, { status: 'succeeded', phase: 'checked', endedAt: now() });
        if (cmd === 'stop') return this.stopCurrent(event);
        let target;
        if (cmd === 'activate' || cmd === 'stage') {
          target = await stage(this.instance, archive, folder);
          if (cmd === 'stage')
            return this.record(event, { target, status: 'succeeded', phase: 'installed', endedAt: now() });
        } else if (cmd === 'rollback') {
          target = (await this.state()).previous;
          if (!target) throw new Error('There is no previous verified release');
        } else {
          target = await current(this.instance);
          if (!target) throw new Error('This instance does not yet have a current release');
        }
        try {
          await this.switch(event, target, bootstrap, cmd === 'restart');
        } catch (error) {
          await this.record(event, { error: error.message });
          if ((await read(this.journal, null))?.operationId === id) await this.recover();
          throw error;
        }
      });
    } catch (error) {
      const saved = await read(record, event);
      if (!['succeeded', 'failed'].includes(saved.status))
        await this.record(saved, { status: 'failed', error: error.message, endedAt: now() });
      throw error;
    }
    return read(record);
  }
}
