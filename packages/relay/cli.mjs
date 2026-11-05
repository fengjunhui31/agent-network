#!/usr/bin/env node
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { identify } from '@libp2p/identify';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identity, validPeer } from './shared.mjs';
import { Admissions, setSponsor } from './admissions.mjs';

process.umask(0o077);
const {
  positionals: [command, ...args],
  values
} = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    listen: { type: 'string' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' }
  }
});
const file = resolve(values.config ?? 'relay.json');
const read = async () => JSON.parse(await readFile(file, 'utf8'));
async function atomic(path, value) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}
const admissionDir = join(dirname(file), 'admission');
async function admitted(managed) {
  const entries = new Set([...(await read()).allow.map(validPeer), ...managed.permanent()]);
  const names = await readdir(admissionDir).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const p = validPeer(name.slice(0, -5));
    if (JSON.parse(await readFile(join(admissionDir, name), 'utf8')) === true) entries.add(p);
    else entries.delete(p);
  }
  return entries;
}
const help =
  'agent-network-relay init|identity|allow PEER_ID|remove PEER_ID|sponsor PEER_ID|unsponsor PEER_ID|serve|status --config FILE\ninit optionally takes --listen /ip4/0.0.0.0/tcp/4001';
async function main() {
  if (values.version) {
    console.log(JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version);
    return;
  }
  if (!command || values.help) {
    console.log(help);
    return;
  }
  if (command === 'init') {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const config = {
      schemaVersion: 1,
      listen: values.listen ?? '/ip4/127.0.0.1/tcp/4001',
      allow: [],
      maxReservations: 64,
      connectionsPerPeer: 4
    };
    await writeFile(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const config = await read();
  if (config.schemaVersion !== 1 || !Array.isArray(config.allow))
    throw new Error('Invalid relay configuration');
  const { key, card } = await identity(join(dirname(file), 'relay-identity.json'));
  if (['identity', 'init'].includes(command)) {
    console.log(JSON.stringify({ peerId: card.peerId, listen: config.listen }));
    return;
  }
  if (command === 'allow' || command === 'remove') {
    const p = validPeer(args[0]);
    await mkdir(admissionDir, { recursive: true, mode: 0o700 });
    await atomic(join(admissionDir, p + '.json'), command === 'allow');
    console.log(command, p);
    return;
  }
  if (['sponsor', 'unsponsor'].includes(command)) {
    await setSponsor(dirname(file), validPeer(args[0]), command === 'sponsor');
    console.log(command, args[0]);
    return;
  }
  const statusFile = join(dirname(file), 'relay-status.json');
  if (command === 'status') {
    console.log(await readFile(statusFile, 'utf8'));
    return;
  }
  if (command !== 'serve') throw new Error(help);
  const managed = new Admissions(dirname(file));
  await managed.start();
  let acl = await admitted(managed),
    denied = 0;
  const deniedPeer = (p) => !acl.has(p.toString());
  const limit = (value, defaultValue, max) => {
    const n = value ?? defaultValue;
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('Invalid relay resource limit');
    return n;
  };
  const established = new Map();
  const rate = new Map();
  const relay = await createLibp2p({
    start: false,
    privateKey: key,
    addresses: { listen: [config.listen] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      maxConnections: limit(config.maxConnections, 256, 4096),
      inboundConnectionThreshold: limit(config.inboundPerSecond, 20, 240),
      maxIncomingPendingConnections: 32
    },
    connectionGater: {
      denyInboundEncryptedConnection: (p) => deniedPeer(p) && !managed.voucher(p.toString()),
      denyInboundRelayReservation: (p) => {
        const deny = deniedPeer(p);
        if (deny) denied++;
        return deny;
      },
      denyOutboundRelayedConnection: (a, b) => {
        const from = a.toString(),
          now = Date.now();
        let r = rate.get(from);
        if (!r || now >= r.until) {
          r = { used: 0, until: now + 60000 };
          rate.set(from, r);
        }
        const deny = deniedPeer(a) || deniedPeer(b) || ++r.used > limit(config.circuitsPerMinute, 120, 2000);
        if (deny) denied++;
        else established.set(from, (established.get(from) ?? 0) + 1);
        return deny;
      }
    },
    services: {
      identify: identify(),
      relay: circuitRelayServer({
        reservations: {
          maxReservations: limit(config.maxReservations, 64, 4096),
          applyDefaultLimit: true,
          defaultDurationLimit: limit(config.circuitSeconds, 120, 3600) * 1000,
          defaultDataLimit: BigInt(limit(config.circuitBytes, 1048576, 16777216))
        },
        maxInboundHopStreams: limit(config.connectionsPerPeer, 4, 32)
      })
    }
  });
  await managed.attach(relay);
  await relay.start();
  let writes = Promise.resolve();
  function update(state) {
    writes = writes
      .catch(() => {})
      .then(async () => {
        try {
          await managed.refresh();
          acl = await admitted(managed);
        } catch (e) {
          acl = new Set();
          managed.sponsors = new Set();
          console.error('Relay admission update failed; denying all peers');
        }
        for (const c of relay.getConnections())
          if (deniedPeer(c.remotePeer) && !managed.voucher(c.remotePeer.toString()))
            await c
              .close({ signal: AbortSignal.timeout(1500) })
              .catch(() => c.abort(new Error('Relay admission revoked')));
        for (const k of rate.keys()) if (!acl.has(k) || rate.get(k).until < Date.now()) rate.delete(k);
        await atomic(statusFile, {
          state,
          pid: process.pid,
          peerId: card.peerId,
          listen: config.listen,
          addresses: relay.getMultiaddrs().map((a) => a.toString()),
          updatedAt: new Date().toISOString(),
          reservations: [...relay.services.relay.reservations.keys()]
            .filter((x) => !deniedPeer(x) && relay.getConnections(x).length)
            .map((x) => x.toString()),
          allowed: acl.size,
          denied,
          circuits: Object.fromEntries(established)
        });
      });
    return writes;
  }
  await update('ready');
  console.log('Relay ready', card.peerId);
  const timer = setInterval(() => void update('ready').catch((e) => console.error(e.message)), 2000);
  const close = async () => {
    clearInterval(timer);
    await relay.stop();
    await update('stopped');
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
}
try {
  await main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
