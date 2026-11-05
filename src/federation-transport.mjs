import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr } from '@multiformats/multiaddr';
import { validPeer } from './federation-identity.mjs';

export const protocol = '/shiyanjia/agent-network/1.0.0';
const maxBody = 48 * 1024,
  timeout = 8000;
const directory = '/tmp/agent-network-nodes-' + process.getuid();
const localPath = (id) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new Error('Invalid network UUID');
  return join(directory, id + '.noise.sock');
};
const unix = (path) => '/unix/' + encodeURIComponent(path);
const fail = (code, detail) => Object.assign(new Error(code + ': ' + detail), { code });
function relayAddress(config) {
  validPeer(config.peerId);
  const addr = multiaddr(config.address);
  if (!/^\/(ip4|ip6|dns4|dns6|dns)\/[^/]+\/tcp\/[1-9]\d*$/.test(addr.toString()))
    throw new Error('Relay address must be a TCP multiaddress without peer suffix');
  return addr.toString() + '/p2p/' + config.peerId;
}
function encode(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxBody) throw fail('bad_frame', 'frame exceeds 48 KiB');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
async function decode(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxBody + 4) throw fail('bad_frame', 'oversized stream');
    chunks.push(Buffer.from(chunk.subarray()));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== bytes.length - 4)
    throw fail('bad_frame', 'invalid frame size');
  return JSON.parse(bytes.subarray(4).toString('utf8'));
}
async function socketState(path) {
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || dir.mode & 0o077)
    throw fail('unsafe_local_endpoint', 'invalid socket directory');
  let s;
  try {
    s = await lstat(path);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (!s.isSocket() || s.uid !== process.getuid() || s.mode & 0o077)
    throw fail('unsafe_local_endpoint', 'invalid socket owner, mode or type');
  return true;
}
async function reachableSocket(path) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(path);
    s.setTimeout(750, () => s.destroy(fail('local_timeout', 'local listener did not answer')));
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', (e) => {
      if (['ECONNREFUSED', 'ENOENT'].includes(e.code)) resolve(false);
      else reject(e);
    });
  });
}
export class FederationTransport {
  constructor(card, relay, receive) {
    this.card = card;
    this.base = relayAddress(relay);
    this.relayPeer = relay.peerId;
    this.receive = receive;
    this.lastRoutes = new Map();
    this.verified = new WeakMap();
    this.pendingDials = new Map();
    this.reservationError = null;
    this.closing = false;
    this.inflight = 0;
  }
  async start(key) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = localPath(this.card.networkId);
    if (await socketState(path)) {
      if (await reachableSocket(path)) throw new Error('Local federation identity is already running');
      await rm(path);
    }
    const local = unix(path),
      circuit = this.base + '/p2p-circuit';
    let relayTransport;
    this.node = await createLibp2p({
      start: false,
      privateKey: key,
      addresses: { listen: [local] },
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      transports: [tcp(), (components) => (relayTransport = circuitRelayTransport()(components))],
      services: { identify: identify() },
      connectionManager: { maxConnections: 96 },
      connectionGater: {
        denyDialMultiaddr: (addr) => {
          const a = addr.toString();
          return !(
            a === this.base ||
            a.startsWith(circuit + '/p2p/') ||
            a.startsWith('/unix/' + encodeURIComponent(directory + '/'))
          );
        }
      }
    });
    try {
      await this.node.handle(
        protocol,
        async (stream, c) => {
          this.inflight++;
          const timer = setTimeout(() => stream.abort(fail('timeout', 'inbound frame deadline')), timeout);
          try {
            if (c.encryption !== '/noise') throw fail('identity_mismatch', 'Noise required');
            const f = await decode(stream);
            if (f.to !== this.card.networkId || !f.from || f.from === f.to)
              throw fail('identity_mismatch', 'wrong network');
            localPath(f.from);
            const route = c.remoteAddr.toString().includes('/p2p-circuit') ? 'relay' : 'local';
            if (
              route === 'relay' &&
              !c.remoteAddr.toString().includes('/p2p/' + this.relayPeer + '/p2p-circuit')
            )
              throw fail('identity_mismatch', 'wrong relay');
            const value =
              f.action === 'hello'
                ? { ...this.card, protocol }
                : await this.receive(c.remotePeer.toString(), f, route);
            stream.send(encode({ ok: true, value }));
          } catch (e) {
            try {
              stream.send(
                encode({ ok: false, code: e.code ?? 'rejected', detail: String(e.message).slice(0, 400) })
              );
            } catch {}
          } finally {
            try {
              await stream.close({ signal: AbortSignal.timeout(1200) });
            } catch {}
            clearTimeout(timer);
            this.inflight--;
          }
        },
        { runOnLimitedConnection: true, maxInboundStreams: 32, maxOutboundStreams: 32 }
      );
      await this.node.start();
      await chmod(path, 0o600);
      this.listener = relayTransport.createListener({});
      this.retryDelay = 1000;
      this.reserve();
    } catch (e) {
      await this.node.stop().catch(() => {});
      throw e;
    }
  }
  reserve() {
    if (this.closing) return;
    this.reserving = (async () => {
      if (!this.listener.getAddrs().length) await this.listener.listen(multiaddr(this.base + '/p2p-circuit'));
      this.reservationError = null;
      this.retryDelay = 2000;
    })()
      .catch(() => {
        this.reservationError = 'relay_unavailable_or_denied';
        this.retryDelay = Math.min(30000, this.retryDelay * 2);
      })
      .finally(() => {
        if (!this.closing)
          this.timer = setTimeout(
            () => this.reserve(),
            this.retryDelay + Math.floor(Math.random() * 250)
          ).unref();
      });
  }
  status() {
    return {
      card: this.card,
      relayPeerId: this.relayPeer,
      reserved: Boolean(this.listener?.getAddrs().length),
      error: this.reservationError,
      routes: Object.fromEntries(this.lastRoutes)
    };
  }
  async connection(addr, peer, route) {
    const same = (c) =>
      c.status === 'open' &&
      c.remotePeer.toString() === peer &&
      c.encryption === '/noise' &&
      (route === 'local'
        ? c.remoteAddr.toString().startsWith('/unix/')
        : c.remoteAddr.toString().includes('/p2p/' + this.relayPeer + '/p2p-circuit'));
    const existing = this.node.getConnections().find(same);
    if (existing) return existing;
    if (!this.pendingDials.has(addr)) {
      const p = this.node
        .dial(multiaddr(addr), { force: true, signal: AbortSignal.timeout(timeout) })
        .then((c) => {
          if (!same(c)) throw fail('identity_mismatch', 'unexpected peer or route');
          return c;
        })
        .finally(() => this.pendingDials.delete(addr));
      this.pendingDials.set(addr, p);
    }
    return this.pendingDials.get(addr);
  }
  async exchange(c, frame, application) {
    const bytes = encode(frame);
    let s;
    try {
      s = await c.newStream(protocol, { runOnLimitedConnection: true, signal: AbortSignal.timeout(timeout) });
    } catch {
      throw fail('peer_unreachable', 'could not open a stream before sending');
    }
    const timer = setTimeout(() => s.abort(new Error('reply timeout')), timeout);
    let response;
    try {
      s.send(bytes);
      await s.close({ signal: AbortSignal.timeout(timeout) });
      response = await decode(s);
    } catch (e) {
      s.abort(e);
      throw fail(application ? 'delivery_unknown' : 'unreachable', 'endpoint acknowledgement unavailable');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw fail(response.code ?? 'rejected', response.detail ?? 'rejected by recipient');
    return response.value;
  }
  async call(contact, frame) {
    if (this.closing) throw fail('busy_draining', 'transport closing');
    const { networkId, peerId } = contact;
    validPeer(peerId);
    const path = localPath(networkId);
    let c, route;
    if ((await socketState(path)) && (await reachableSocket(path))) {
      route = 'local';
      try {
        c = await this.connection(unix(path) + '/p2p/' + peerId, peerId, route);
      } catch {
        if ((await socketState(path)) && (await reachableSocket(path)))
          throw fail('identity_mismatch', 'local authenticated dial failed; verify the pinned identity');
      }
    }
    if (!c) {
      route = 'relay';
      try {
        c = await this.connection(this.base + '/p2p-circuit/p2p/' + peerId, peerId, route);
      } catch {
        throw fail(
          this.status().reserved ? 'peer_unreachable' : 'relay_unavailable',
          'could not establish a pinned relay circuit'
        );
      }
    }
    const fields = { from: this.card.networkId, to: networkId };
    if (this.verified.get(c) !== networkId) {
      const hello = await this.exchange(c, { ...fields, action: 'hello' }, false);
      if (hello.peerId !== peerId || hello.networkId !== networkId || hello.protocol !== protocol)
        throw fail('identity_mismatch', 'peer hello did not match invitation');
      this.verified.set(c, networkId);
    }
    this.lastRoutes.set(networkId, {
      route,
      verifiedAt: new Date().toISOString(),
      encryption: c.encryption,
      peerId,
      relayPeerId: route === 'relay' ? this.relayPeer : null
    });
    try {
      return await this.exchange(c, { ...frame, ...fields }, frame.action === 'message');
    } catch (error) {
      if (error.code === 'delivery_unknown')
        throw fail(error.code, 'messageId ' + frame.messageId + '; acknowledgement unavailable');
      throw error;
    }
  }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    await this.listener?.close().catch(() => {});
    await this.node?.stop();
    await this.reserving?.catch(() => {});
  }
}
