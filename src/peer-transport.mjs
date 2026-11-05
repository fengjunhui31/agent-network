import http from 'node:http';
import net from 'node:net';
import { mkdir, lstat, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const networkId = z.string().uuid();
const directory = '/tmp/agent-network-nodes-' + process.getuid();
const socket = id => join(directory, networkId.parse(id) + '.sock');
const limit = 48 * 1024;

async function readBody(stream) {
  const chunks = []; let size = 0;
  for await (const part of stream) {
    size += part.length;
    if (size > limit) throw new Error('Node message is too large');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// One local socket per network identity, independent of its changing service port.
// The socket accepts link operations and text only. Instance administration stays on the host API.
export function callPeer(to, from, link, action, data = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath:socket(to), path:'/node', method:'POST', agent:false,
      headers:{ authorization:'Bearer '+link.secret, 'content-type':'application/json' } }, async res => {
      try {
        const reply = await readBody(res);
        if (res.statusCode !== 200) throw new Error(reply.error ?? 'Peer rejected the request');
        resolve(reply);
      } catch (e) { reject(e); }
    });
    const timer = setTimeout(() => request.destroy(new Error('Peer response timed out; delivery is unconfirmed')), 4500);
    request.once('close', () => clearTimeout(timer));
    request.on('error', err => reject(['ENOENT','ECONNREFUSED'].includes(err.code)
      ? new Error('Peer is offline; nothing was queued') : err));
    request.end(JSON.stringify({ from,to,linkId:link.linkId,action,data }));
  });
}
async function listen(server, path) {
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(path, () => {server.off('error',fail);done();});
  });
}
export async function openPeerSocket(id, receive) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw new Error('Unsafe local peer socket directory');
  const path = socket(id);
  const server = http.createServer(async (req,res) => {
    const output = (code,data) => {res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if (req.method !== 'POST' || req.url !== '/node') return output(404,{error:'Unknown node endpoint'});
    const match = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '');
    if (!match) return output(401,{error:'Link credential required'});
    try { output(200,await receive(match[1],await readBody(req))); }
    catch (e) { output(400,{error:e.message}); }
  });
  try { await listen(server,path); }
  catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const entry = await lstat(path);
    if (!entry.isSocket() || entry.uid !== process.getuid()) throw new Error('Peer socket path is occupied');
    const stale = await new Promise(done => {
      const probe = net.createConnection(path);
      probe.once('connect',()=>{probe.destroy();done(false);});
      probe.once('error',err=>done(err.code === 'ECONNREFUSED'));
    });
    if (!stale) throw new Error('Another live instance owns this network identity');
    await unlink(path); await listen(server,path);
  }
  const close = () => new Promise(resolve => server.close(resolve));
  try { await chmod(path,0o600); }
  catch (error) { await close(); throw error; }
  return close;
}
