import { randomUUID } from 'node:crypto';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { identify } from '@libp2p/identify';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { z } from 'zod';
import { validPeer } from './federation-identity.mjs';
import { admissionRPC, claimBytes } from './host-wire.mjs';

export const alias = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const peer = z
  .string()
  .max(100)
  .refine((s) => {
    try {
      return validPeer(s) === s;
    } catch {
      return false;
    }
  });
export const cardSpec = z.object({ networkId: z.string().uuid(), peerId: peer }).strict();
export const relaySpec = z
  .object({
    address: z
      .string()
      .max(300)
      .refine((s) => {
        try {
          return /^\/(ip4|ip6|dns4|dns6|dns)\/[^/]+\/tcp\/[1-9]\d*$/.test(multiaddr(s).toString());
        } catch {
          return false;
        }
      }),
    peerId: peer
  })
  .strict();
export const inviteSpec = z
  .object({
    kind: z.literal('owned-host'),
    version: z.literal(1),
    id: z.string().uuid(),
    issuer: cardSpec,
    alias,
    relay: relaySpec,
    expires: z.number().int().positive(),
    bootstrap: peer,
    secret: z.string().min(8).max(300)
  })
  .strict();

export async function voucher(issuer, relay, name) {
  const key = await generateKeyPair('Ed25519');
  return inviteSpec.parse({
    kind: 'owned-host',
    version: 1,
    id: randomUUID(),
    issuer,
    relay,
    alias: name,
    expires: Date.now() + 86400000,
    bootstrap: peerIdFromPrivateKey(key).toString(),
    secret: Buffer.from(privateKeyToProtobuf(key)).toString('base64')
  });
}
export async function claim(inv, card, key) {
  const secret = privateKeyFromProtobuf(Buffer.from(inv.secret, 'base64'));
  if (peerIdFromPrivateKey(secret).toString() !== inv.bootstrap || inv.expires <= Date.now())
    throw new Error('Invalid or expired host invitation');
  const node = await createLibp2p({
    start: false,
    privateKey: secret,
    addresses: { listen: [] },
    transports: [tcp()],
    services: { identify: identify() },
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()]
  });
  try {
    await node.start();
    const c = await node.dial(multiaddr(inv.relay.address + '/p2p/' + inv.relay.peerId), {
      signal: AbortSignal.timeout(8000)
    });
    if (c.remotePeer.toString() !== inv.relay.peerId) throw new Error('Relay identity mismatch');
    const proof = Buffer.from(await key.sign(claimBytes(inv.id, inv.issuer.peerId, card))).toString('base64');
    return await admissionRPC(c, { action: 'claim', id: inv.id, card, proof });
  } finally {
    await node.stop();
  }
}
