import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Admissions, setSponsor } from '../admissions.mjs';
import { identity } from '../shared.mjs';
import { claimBytes } from '../wire.mjs';
test('vouchers are bounded to their first signed claimant and only their sponsor can approve or revoke them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'host-sponsor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const make = (n) => identity(join(dir, n, 'identity.json'));
  const [a, v, b, c] = await Promise.all(['primary', 'voucher', 'device', 'other'].map(make));
  const service = new Admissions(dir),
    id = randomUUID();
  await service.start();
  const issue = { id, action: 'issue', bootstrap: v.card.peerId, expires: Date.now() + 60000 };
  await assert.rejects(service.handle(a.card.peerId, issue), /sponsor/);
  await setSponsor(dir, a.card.peerId, true);
  await service.refresh();
  await service.handle(a.card.peerId, issue);
  assert(service.voucher(v.card.peerId));
  assert.deepEqual(service.permanent(), []);
  const req = async (k) => ({
    id,
    action: 'claim',
    card: k.card,
    proof: Buffer.from(await k.key.sign(claimBytes(id, a.card.peerId, k.card))).toString('base64')
  });
  assert.equal((await service.handle(v.card.peerId, await req(b))).state, 'pending');
  await assert.rejects(service.handle(v.card.peerId, await req(c)), /bound/);
  await assert.rejects(service.handle(c.card.peerId, { id, action: 'status' }), /issuing/);
  const admission = { issuer: a.card, audience: b.card, preapproved: true };
  await service.handle(a.card.peerId, { id, action: 'approve', admission });
  assert.deepEqual(service.permanent(), [b.card.peerId]);
  const next = new Admissions(dir);
  await next.start();
  assert.deepEqual(next.permanent(), [b.card.peerId]);
  await next.handle(a.card.peerId, { id, action: 'revoke' });
  assert(!next.voucher(v.card.peerId));
  assert.deepEqual(next.permanent(), []);
  await assert.rejects(next.handle(a.card.peerId, { id, action: 'approve', admission }));
});
