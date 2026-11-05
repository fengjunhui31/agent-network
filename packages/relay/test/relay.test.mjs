import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
test('relay identity survives restart and admission is explicit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'relay.json');
  const call = (...args) =>
    execFileSync(process.execPath, [cli, ...args, '--config', path], { encoding: 'utf8' });
  const card = JSON.parse(call('init'));
  assert.equal(JSON.parse(call('identity')).peerId, card.peerId);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).allow, []);
  call('allow', card.peerId);
  assert.equal(JSON.parse(await readFile(join(dir, 'admission', card.peerId + '.json'), 'utf8')), true);
  call('remove', card.peerId);
  assert.equal(JSON.parse(await readFile(join(dir, 'admission', card.peerId + '.json'), 'utf8')), false);
});
