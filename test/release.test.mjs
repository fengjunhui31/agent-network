import assert from 'node:assert/strict';
import { alive } from '../scripts/release-service.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { hash, readArchive } from '../scripts/release-archive.mjs';
import { withReleaseLock } from '../scripts/release-lock.mjs';

test('archive reader rejects traversal, links, duplicate paths and an incorrect external digest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'archive-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, headers] of [
    ['parent', [{ name: 'agent-network/src/../network.json' }]],
    ['link', [{ name: 'agent-network/src/server.mjs', type: 'symlink', linkname: '../../network.json' }]],
    ['duplicate', [{ name: 'agent-network/src/server.mjs' }, { name: 'agent-network/src/server.mjs' }]]
  ]) {
    const pack = tar.pack(),
      contents = buffer(pack);
    for (const header of headers) pack.entry(header, Buffer.alloc(0));
    pack.finalize();
    const file = join(root, name + '.tar.gz'),
      data = gzipSync(await contents);
    await writeFile(file, data);
    await writeFile(file + '.sha256', hash(data) + '  ' + name + '.tar.gz\n');
    await assert.rejects(readArchive(file), /Unexpected archive entry/);
    await writeFile(file + '.sha256', 'wrong');
    await assert.rejects(readArchive(file), /SHA-256 mismatch/);
  }
});

test('release operations exclude a second controller and unlock after failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'controller-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.local'));
  await assert.rejects(
    withReleaseLock(root, async () => {
      await assert.rejects(
        withReleaseLock(root, async () => assert.fail('second controller started')),
        /Another release operation/
      );
      throw new Error('injected operation failure');
    }),
    /injected operation failure/
  );
  assert.equal(await withReleaseLock(root, async () => 7), 7);
});

test(
  'Linux can identify the live controller when ps is unavailable',
  { skip: process.platform !== 'linux' },
  () => {
    const before = process.env.PATH;
    process.env.PATH = '/nonexistent-agent-network-bin';
    try {
      assert.equal(alive(process.pid), true);
    } finally {
      process.env.PATH = before;
    }
  }
);
