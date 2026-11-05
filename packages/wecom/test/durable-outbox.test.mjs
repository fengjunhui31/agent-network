import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DurableOutbox } from '../src/durable-outbox.mjs';
import { INSTANCE_ROOT, writeJson } from '../../../src/paths.mjs';

async function directory(t) {
  const base = resolve(INSTANCE_ROOT, '.local/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'outbox-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(5); }
  throw new Error('Outbox did not reach the expected state');
}

test('enqueue returns before delivery; one sender preserves order across conversations', async t => {
  const root = await directory(t); const delivered = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const box = await DurableOutbox.open(root, { deliver: async item => {
    delivered.push(item.content); if (item.content === 'first') await gate; return { errcode: 0 };
  } });
  t.after(async () => { release(); await box.close(); });
  const first = await box.enqueue({ key: 'first', kind: 'text', chatid: 'group-a', content: 'first' });
  await until(() => delivered.length === 1);
  const second = await box.enqueue({ key: 'second', kind: 'text', chatid: 'group-b', content: 'second' });
  assert.equal(first.queued, true); assert.equal(second.queued, true);
  assert.deepEqual(delivered, ['first']);
  assert.equal(box.items.get(second.messageId).status, 'pending');
  release(); await box.flush([first.messageId, second.messageId]);
  assert.deepEqual(delivered, ['first', 'second']);
  assert.equal((await stat(resolve(root, `${first.messageId}.json`))).mode & 0o777, 0o600);
});

test('failed and interrupted sends recover after restart; acknowledged messages are not sent twice', async t => {
  const root = await directory(t);
  const box = await DurableOutbox.open(root, { deliver: async () => { throw new Error('offline'); } });
  const first = await box.enqueue({ key: 'a', kind: 'text', chatid: 'group-a', content: 'saved message' });
  await box.running; assert.equal(box.items.get(first.messageId).status, 'pending'); await box.close();
  // A process can die while the SDK is waiting for a receipt.
  const item = box.items.get(first.messageId); item.status = 'sending';
  await writeJson(resolve(root, `${item.id}.json`), item);
  const delivered = [];
  const reopened = await DurableOutbox.open(root, { deliver: async item => { delivered.push(item.content); return { errcode: 0 }; } });
  assert.equal(reopened.items.get(first.messageId).status, 'pending');
  await reopened.flush([first.messageId]); await reopened.close();
  const again = await DurableOutbox.open(root, { deliver: async item => { delivered.push(item.content); return { errcode: 0 }; } });
  const duplicate = await again.enqueue({ key: 'a', kind: 'text', chatid: 'group-a', content: 'saved message' });
  await again.flush([duplicate.messageId]); await again.close();
  assert.equal(duplicate.messageId, first.messageId); assert.deepEqual(delivered, ['saved message']);
});

test('queued attachments retain their original content while the shared workspace changes', async t => {
  const root = await directory(t); const source = resolve(root, 'source.txt'); await writeFile(source, 'original');
  const directoryPath = resolve(root, 'queue');
  const box = await DurableOutbox.open(directoryPath, { deliver: async () => { throw new Error('offline'); } });
  const queued = await box.enqueue({ key: 'file', kind: 'file', chatid: 'group-a', path: source, filename: 'report.txt' });
  await box.running; await box.close(); await writeFile(source, 'new version');
  const delivered = [];
  const reopened = await DurableOutbox.open(directoryPath, { deliver: async item => {
    delivered.push(await readFile(item.path, 'utf8')); return { errcode: 0 };
  } });
  await reopened.flush([queued.messageId]); await reopened.close();
  assert.deepEqual(delivered, ['original']);
});
