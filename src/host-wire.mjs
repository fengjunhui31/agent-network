import { peerIdFromString } from '@libp2p/peer-id';

export const admissionProtocol = '/shiyanjia/agent-network/host-admission/1.0.0';
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function claimBytes(id, sponsor, card) {
  return Buffer.from(JSON.stringify(['owned-host/1', id, sponsor, card.networkId, card.peerId]));
}
export async function validClaim(id, sponsor, card, proof) {
  if (!uuid.test(card?.networkId) || typeof proof !== 'string' || proof.length > 128) return false;
  try {
    const peer = peerIdFromString(card.peerId);
    return (
      peer.type === 'Ed25519' &&
      peer.toString() === card.peerId &&
      (await peer.publicKey.verify(claimBytes(id, sponsor, card), Buffer.from(proof, 'base64')))
    );
  } catch {
    return false;
  }
}
const maxFrame = 48 * 1024;
export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxFrame) throw Object.assign(new Error('Frame exceeds 48 KiB'), { code: 'bad_frame' });
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
export async function readFrame(stream) {
  const chunks = [];
  let size = 0;
  for await (const part of stream) {
    size += part.byteLength;
    if (size > maxFrame + 4) throw Object.assign(new Error('Oversized frame'), { code: 'bad_frame' });
    chunks.push(Buffer.from(part.subarray()));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== bytes.length - 4)
    throw Object.assign(new Error('Invalid frame'), { code: 'bad_frame' });
  return JSON.parse(bytes.subarray(4).toString('utf8'));
}
export async function admissionRPC(connection, request) {
  if (connection.encryption !== '/noise') throw new Error('Authenticated relay connection required');
  const stream = await connection.newStream(admissionProtocol, { signal: AbortSignal.timeout(8000) });
  const timer = setTimeout(() => stream.abort(new Error('Relay admission timeout')), 8000);
  try {
    stream.send(encodeFrame(request));
    await stream.close({ signal: AbortSignal.timeout(8000) });
    const reply = await readFrame(stream);
    if (!reply.ok) throw new Error(reply.error || 'Admission rejected');
    return reply.value;
  } finally {
    clearTimeout(timer);
  }
}
