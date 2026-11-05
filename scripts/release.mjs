#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ReleaseController } from './release-controller.mjs';
import { detached, envFor, exists, now, read } from './release-service.mjs';

const script = fileURLToPath(import.meta.url),
  root = dirname(dirname(script));
const pkg = await read(join(root, 'package.json'));
const usage =
  'agent-network-release ' +
  pkg.version +
  '\n' +
  '  agent-network-release stage|activate|schedule INSTANCE [--archive ARCHIVE] [--wait SECONDS]\n' +
  '  agent-network-release start|stop|restart|rollback|recover|status INSTANCE [--wait SECONDS]\n' +
  '  The installed CLI uses its bundled application by default. Use --bootstrap-from ARCHIVE for a legacy 0.2.0 source instance.';
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      archive: { type: 'string' },
      instance: { type: 'string' },
      wait: { type: 'string', default: '900' },
      operation: { type: 'string' },
      'bootstrap-from': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }
    }
  });
  if (values.version) {
    console.log(pkg.version);
    return;
  }
  const [command, argument, ...extra] = positionals;
  if (values.help || !command || command === 'help') {
    console.log(usage);
    return;
  }
  if (
    !['stage', 'activate', 'schedule', 'start', 'stop', 'restart', 'rollback', 'recover', 'status'].includes(
      command
    ) ||
    extra.length
  )
    throw new Error(usage);
  const seconds = Number(values.wait);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('--wait must be a positive number of seconds');
  const bundled = pkg.name === '@shiyanjia/agent-network';
  const defaultInstance =
    basename(dirname(root)) === 'releases' ? dirname(dirname(root)) : bundled ? undefined : root;
  const target = values.instance ?? argument ?? process.env.LAN_INSTANCE_ROOT ?? defaultInstance;
  if (!target) throw new Error('Specify an instance directory');
  const instance = await realpath(resolve(target));
  if (!(await exists(join(instance, 'network.json'))))
    throw new Error('The instance must have its own network.json');
  const needsArchive = ['stage', 'activate', 'schedule'].includes(command);
  let archive = values.archive ?? (values.instance ? argument : undefined);
  if (!needsArchive && (archive || values['bootstrap-from']))
    throw new Error(command + ' does not take an archive');
  if (needsArchive) {
    const filename = 'agent-network-' + pkg.version + '.tar.gz';
    archive = await realpath(resolve(archive ?? join(root, bundled ? 'release' : 'dist', filename)));
  }
  const bootstrap = values['bootstrap-from'] ? resolve(values['bootstrap-from']) : null;
  const controller = new ReleaseController(instance, seconds);
  if (command === 'status') {
    console.log(JSON.stringify(await controller.status(), null, 2));
    return;
  }
  const id = values.operation ?? now().replaceAll(':', '') + '-' + randomUUID().slice(0, 8);
  const folder = controller.folder(id);
  if (command === 'schedule') {
    if (values.operation) throw new Error('schedule creates its own operation ID');
    await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
    await mkdir(folder, { mode: 0o700 });
    const event = {
      schemaVersion: 1,
      operationId: id,
      action: 'activate',
      status: 'scheduled',
      startedAt: now(),
      archive
    };
    await controller.record(event);
    try {
      const args = ['activate', instance, '--archive', archive, '--wait', String(seconds), '--operation', id];
      if (bootstrap) args.push('--bootstrap-from', bootstrap);
      await detached(script, args, instance, envFor(instance), join(folder, 'supervisor.log'));
    } catch (error) {
      await controller.record(event, { status: 'failed', error: error.message, endedAt: now() });
      throw error;
    }
    console.log('Scheduled', id, 'record:', join(folder, 'upgrade-record.json'));
    return;
  }
  if (values.operation && command !== 'activate')
    throw new Error('An operation ID is reserved for scheduled activation');
  const event = await controller.operate(command, archive, bootstrap, id, Boolean(values.operation));
  console.log(event.status, id, join(folder, 'upgrade-record.json'));
}
process.umask(0o077);
try {
  await main();
} catch (error) {
  console.error('Release operation failed:', error.message);
  process.exitCode = 1;
}
