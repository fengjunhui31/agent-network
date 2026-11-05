import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';

export function validPeer(value) {
  const id = peerIdFromString(value);
  if (id.toString() !== value || id.type !== 'Ed25519')
    throw new Error('Expected a canonical Ed25519 Peer ID');
  return value;
}
export async function identity(file, expectedNetworkId) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(file));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077)
    throw new Error('Use a private identity directory owned by this user (0700)');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const key = await generateKeyPair('Ed25519');
    const data = {
      version: 1,
      networkId: expectedNetworkId ?? randomUUID(),
      key: Buffer.from(privateKeyToProtobuf(key)).toString('base64')
    };
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(data) + '\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temp, file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } finally {
      await rm(temp, { force: true });
    }
    raw = await readFile(file, 'utf8');
  }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error('Identity file must belong to this user with mode 0600');
  const d = JSON.parse(raw);
  if (
    d.version !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(d.networkId) ||
    (expectedNetworkId && d.networkId !== expectedNetworkId)
  )
    throw new Error('The persisted network identity differs from the instance');
  const key = privateKeyFromProtobuf(Buffer.from(d.key, 'base64'));
  const peerId = validPeer(peerIdFromPrivateKey(key).toString());
  return { key, card: { networkId: d.networkId, peerId } };
}
