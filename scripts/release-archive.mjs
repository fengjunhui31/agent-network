// The bootstrap and the source checkout share the same archive reader and manifest format.
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFile, writeFile, readdir, mkdir, link, rm, rename } from 'node:fs/promises';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buffer } from 'node:stream/consumers';
import tar from 'tar-stream';

const fixed = [
  'package.json',
  'package-lock.json',
  'runtime-versions.json',
  'CHANGELOG.md',
  'network.example.json',
  'credentials.example.json'
];
const docs = ['docs/ARCHITECTURE.md', 'docs/TEAM.md', 'docs/RELEASING.md', 'docs/INSTALL.md'];
const guides = [
  'skills/agent-network/SKILL.md',
  'skills/agent-network/references/coordinator.md',
  'docs/ARCHITECTURE.md',
  'docs/RELEASING.md'
];
const prefix = 'agent-network/';
const maxSize = 32 * 1024 * 1024;
export const layout = 'project-local-v1';
export const hash = (data) => createHash('sha256').update(data).digest('hex');

export function allowed(name) {
  if (
    !name ||
    posix.normalize(name) !== name ||
    name.startsWith('/') ||
    name.split('/').includes('..') ||
    name.includes('\\') ||
    name.includes('\0')
  )
    return false;
  // The .py scripts and bundled WeCom files occur in earlier immutable releases.
  return (
    fixed.includes(name) ||
    docs.includes(name) ||
    ['README.md', 'docs/WECOM-FLOW.md', 'wecom.example.json'].includes(name) ||
    /^(src|test|scripts)\/[^/]+\.(mjs|py)$/.test(name) ||
    /^skills\/agent-network\/.+\.md$/.test(name)
  );
}

function orderedFiles(files) {
  return Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((name) => [name, files[name]])
  );
}
export function identity(version, files) {
  // The old builder uses Python's compact, sorted, ASCII-escaped JSON.
  const json = JSON.stringify({ files: orderedFiles(files), version }).replace(
    /[\u007f-\uffff]/g,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
  );
  return hash(json);
}
function guideRevision(files) {
  const digest = createHash('sha256');
  for (const name of guides)
    digest
      .update(name + '\0')
      .update(files.get(name))
      .update('\0');
  return digest.digest('hex').slice(0, 12);
}
function inspect(files) {
  const manifest = JSON.parse(files.get('release-manifest.json'));
  const pkg = JSON.parse(files.get('package.json'));
  const hashes = orderedFiles(
    Object.fromEntries(
      [...files]
        .filter(([name]) => name !== 'release-manifest.json')
        .map(([name, data]) => [name, hash(data)])
    )
  );
  if (
    JSON.stringify(orderedFiles(manifest.files)) !== JSON.stringify(hashes) ||
    identity(manifest.version, hashes) !== manifest.buildId
  ) {
    throw new Error('Package checksum mismatch');
  }
  if (
    manifest.version !== pkg.version ||
    manifest.networkGuideRevision !== guideRevision(files) ||
    manifest.dependencyLockSha256 !== hashes['package-lock.json'] ||
    manifest.runtimeSpecSha256 !== hashes['runtime-versions.json']
  ) {
    throw new Error('Manifest metadata mismatch');
  }
  return { version: manifest.version, buildId: manifest.buildId, files: Object.keys(hashes).length };
}

export async function readArchive(archive, checkSidecar = true) {
  const bytes = await readFile(archive);
  if (bytes.length > maxSize) throw new Error('Application archive is too large');
  const digest = hash(bytes);
  if (
    checkSidecar &&
    (await readFile(archive + '.sha256', 'utf8')).trim() !== digest + '  ' + basename(archive)
  )
    throw new Error('Archive SHA-256 mismatch');
  const extractor = tar.extract();
  const files = new Map();
  extractor.end(gunzipSync(bytes, { maxOutputLength: maxSize }));
  let invalidEntry;
  for await (const member of extractor) {
    const data = await buffer(member);
    const header = member.header;
    const name = header.name.slice(prefix.length);
    if (
      !header.name.startsWith(prefix) ||
      header.type !== 'file' ||
      files.has(name) ||
      (name !== 'release-manifest.json' && !allowed(name))
    ) {
      invalidEntry ??= header.name;
      continue;
    }
    files.set(name, data);
  }
  if (invalidEntry !== undefined) throw new Error('Unexpected archive entry: ' + invalidEntry);
  return { contents: files, info: { ...inspect(files), sha256: digest } };
}

export async function build(root) {
  const files = new Map();
  for (const name of [...fixed, ...docs]) files.set(name, await readFile(join(root, name)));
  files.set('README.md', files.get('docs/INSTALL.md'));
  for (const directory of ['src', 'test', 'scripts', 'skills/agent-network']) {
    for (const entry of await readdir(join(root, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      const name = posix.relative(root, path);
      if (allowed(name)) files.set(name, await readFile(path));
    }
  }
  const pkg = JSON.parse(files.get('package.json')),
    lock = JSON.parse(files.get('package-lock.json'));
  if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version)
    throw new Error('Lockfile and project version differ');
  const hashes = orderedFiles(Object.fromEntries([...files].map(([n, b]) => [n, hash(b)])));
  const manifest = {
    manifestVersion: 1,
    name: pkg.name,
    version: pkg.version,
    buildId: identity(pkg.version, hashes),
    networkGuideRevision: guideRevision(files),
    node: pkg.engines.node,
    stateLayout: layout,
    dependencyLockSha256: hashes['package-lock.json'],
    runtimeSpecSha256: hashes['runtime-versions.json'],
    files: hashes
  };
  files.set('release-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  const pack = tar.pack();
  const packed = buffer(pack);
  for (const name of [...files.keys()].sort())
    pack.entry({ name: prefix + name, mode: 0o644, mtime: new Date(0), uid: 0, gid: 0 }, files.get(name));
  pack.finalize();
  const bytes = gzipSync(await packed, { level: 9 }),
    out = join(root, 'dist');
  await mkdir(out, { recursive: true });
  const archive = join(out, 'agent-network-' + pkg.version + '.tar.gz');
  const tmp = archive + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    try {
      await link(tmp, archive);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await readFile(archive)).equals(bytes))
        throw new Error('This version already has a different build; assign a new version');
    }
    await writeFile(tmp + '.sha256', hash(bytes) + '  ' + basename(archive) + '\n', { mode: 0o644 });
    await rename(tmp + '.sha256', archive + '.sha256');
    return { ...(await readArchive(archive)).info, archive };
  } finally {
    await rm(tmp, { force: true });
    await rm(tmp + '.sha256', { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [action, archive, ...extra] = process.argv.slice(2);
    if (action && (action !== '--verify' || !archive || extra.length))
      throw new Error('Usage: release-archive.mjs [--verify ARCHIVE]');
    const result = action
      ? (await readArchive(resolve(archive))).info
      : await build(dirname(dirname(fileURLToPath(import.meta.url))));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
