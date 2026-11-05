import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { allowed, hash, identity, layout, readArchive } from './release-archive.mjs';
import { envFor, exists, read, save, start, stop, stopUnready, waitReady } from './release-service.mjs';

export async function verifyTree(directory) {
  const manifest = await read(join(directory, 'release-manifest.json'));
  const pkg = await read(join(directory, 'package.json'));
  if (
    manifest.manifestVersion !== 1 ||
    manifest.stateLayout !== layout ||
    manifest.name !== 'local-agent-network' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version) ||
    !/^[a-f0-9]{64}$/.test(manifest.buildId) ||
    manifest.version !== pkg.version ||
    manifest.node !== pkg.engines.node
  ) {
    throw new Error('Unsupported application, version or state layout');
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    const path = join(directory, name);
    if (!allowed(name) || (await realpath(path)) !== path || hash(await readFile(path)) !== digest)
      throw new Error('Installed release differs at ' + name);
  }
  if (identity(manifest.version, manifest.files) !== manifest.buildId)
    throw new Error('Installed build identifier differs');
  return {
    version: manifest.version,
    buildId: manifest.buildId,
    directory,
    guideRevision: manifest.networkGuideRevision,
    stateLayout: layout,
    protocol: manifest.version === '0.2.0' ? 0 : 1
  };
}
export async function validate(instance, release) {
  if (
    dirname(release.directory) !== join(instance, 'releases') ||
    basename(release.directory) !== release.version + '-' + release.buildId ||
    !isDeepStrictEqual(await verifyTree(release.directory), release)
  )
    throw new Error('Installed release metadata or path differs');
  return release;
}
async function checkApplication(app, scratch, logfile, release) {
  const isolated = join(scratch, 'probe-instance');
  await mkdir(join(isolated, '.local'), { recursive: true, mode: 0o700 });
  await copyFile(join(app, 'network.example.json'), join(isolated, 'network.json'));
  const log = await open(logfile, 'w', 0o600);
  try {
    const options = { cwd: app, env: envFor(isolated), stdio: ['ignore', log.fd, log.fd] };
    execFileSync(
      'npm',
      ['ci', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', '--fetch-retries=1'],
      { ...options, timeout: 160000 }
    );
    execFileSync('npm', ['test'], { ...options, timeout: 100000 });
  } finally {
    await log.close();
  }
  const processInfo = await start(isolated, release, null);
  try {
    await waitReady(isolated, release, processInfo, null, 15000);
  } finally {
    if ((await read(join(isolated, '.local/server.lock'), null))?.pid === processInfo.pid)
      await stop(isolated, processInfo.pid);
    else await stopUnready(isolated, app, processInfo.startedAt);
  }
  if (await exists(join(app, '.local'))) throw new Error('Probe wrote state into the application');
}
export async function stage(instance, archive, operation) {
  const { info, contents } = await readArchive(await realpath(archive));
  const releases = join(instance, 'releases');
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(releases, '.stage-'));
  try {
    const app = join(scratch, 'agent-network');
    for (const [name, bytes] of contents) {
      const file = join(app, name);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    }
    const ref = await verifyTree(app);
    const target = join(releases, ref.version + '-' + ref.buildId);
    if ((await readdir(releases)).some((n) => n.startsWith(ref.version + '-') && n !== basename(target)))
      throw new Error('A product version already has a different installed build');
    const installed = { ...ref, directory: target };
    const cached = await exists(target);
    if (!cached) {
      await checkApplication(app, scratch, join(operation, 'stage-' + ref.version + '.log'), ref);
      await verifyTree(app);
      await rename(app, target);
    }
    await validate(instance, installed);
    await save(join(operation, 'stage-' + ref.version + '.json'), {
      ...info,
      applicationRoot: target,
      checked: cached ? 'verified install' : 'npm ci, tests, isolated startup'
    });
    return installed;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
export async function current(instance) {
  const pointer = join(instance, 'current');
  let stat;
  try {
    stat = await lstat(pointer);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isSymbolicLink()) throw new Error('current must be an application symlink');
  const path = await realpath(pointer);
  if (dirname(path) !== join(instance, 'releases'))
    throw new Error('Release directory does not belong to this instance');
  const release = await verifyTree(path);
  if (basename(path) !== release.version + '-' + release.buildId)
    throw new Error('Active release path differs from its identity');
  return release;
}
export async function point(instance, release) {
  await validate(instance, release);
  await current(instance);
  const tmp = join(instance, '.current-' + randomUUID());
  try {
    await symlink(relative(instance, release.directory), tmp);
    await rename(tmp, join(instance, 'current'));
  } finally {
    await rm(tmp, { force: true });
  }
}
