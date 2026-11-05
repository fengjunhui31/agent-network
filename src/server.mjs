import http from 'node:http';
import { openPeerSocket } from './peer-transport.mjs';
import { existsSync } from 'node:fs';
import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { AgentNetwork } from './network.mjs';
import { ROOT, INSTANCE_ROOT, readJson, writeJson } from './paths.mjs';
import { networkVersion, buildId } from './version.mjs';

async function acquire(root) {
  const file = resolve(root, '.local', 'server.lock');
  await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
      return () => rm(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const { pid } = JSON.parse(await readFile(file, 'utf8'));
      try { process.kill(pid, 0); } catch (probe) {
        if (probe.code === 'ESRCH') { await rm(file, { force: true }); continue; }
        throw probe;
      }
      throw new Error(`A network process already owns these member sessions (PID ${pid})`);
    }
  }
  throw new Error('Could not acquire the local network lock');
}

export async function startServer({ network, port = 0, saveEndpoint = true, hold = false, startChannel } = {}) {
  network ??= await AgentNetwork.create({ hold });
  const root = network.root ?? INSTANCE_ROOT;
  const release = saveEndpoint ? await acquire(root) : async () => {};
  const token = randomBytes(32).toString('hex');
  const controlToken = randomBytes(32).toString('hex');
  const discoveryFile = resolve(root, '.local/join.json');
  const previousId=saveEndpoint && (await readJson(discoveryFile,null))?.networkId;
  const savedIdentity=saveEndpoint && network.catalog.config.federation?.enabled && await readJson(resolve(root,'.local/federation/identity.json'),null);
  const networkId=previousId || savedIdentity?.networkId || randomUUID();
  const skill = await readFile(resolve(ROOT, 'skills/agent-network/SKILL.md'), 'utf8');
  const joinGuide = skill.split('## 外部 Agent 加入')[1]?.trim() ?? '';
  async function directory(params) {
    const result = await network.members.manage(params);
    if (params.action === 'pending') return result.concat(await network.peers.manage({action:'pending'}));
    if (params.action === 'query') {
      const search = (params.query ?? '').toLowerCase();
      const nodes = (await network.peers.manage({action:'query'})).filter(n => n.status === 'approved' && !params.id && !params.project
        && [n.address,n.name].some(value=>value.toLowerCase().includes(search)));
      return {...result,nodes};
    }
    return result;
  }
  let closePeer = async () => {};
  if (saveEndpoint) network.peers.id = networkId;
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const reply = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, version: networkVersion, buildId });
    if (req.method === 'GET' && req.url === '/join') {
      return reply(200, { networkId, joinModes:['member','network'], version: networkVersion, coordinator: network.members.coordinator(),
        client: resolve(existsSync(resolve(root,'current/scripts/member.mjs')) ? resolve(root,'current') : ROOT, 'scripts/member.mjs'), guide: joinGuide });
    }
    const self = req.url === '/members/self';
    const owner = ['/maintenance','/members/owner','/nodes/owner','/channel/owner'].includes(req.url);
    const auth = Buffer.from(req.headers.authorization ?? '');
    const actor=network.runCredentials?.get(auth.toString().slice(7));
    const scoped=actor && auth.toString().startsWith('Bearer ') && network.activeRun(actor.agentId,actor.sessionKey)?.runId===actor.runId;
    const expected = Buffer.from(`Bearer ${owner ? controlToken : token}`);
    if (self ? !/^Bearer [a-f0-9]{64}$/.test(auth.toString()) : !scoped && (auth.length !== expected.length || !timingSafeEqual(auth, expected))) return reply(401, { error: 'Unauthorized' });
    if (req.method !== 'POST') return reply(405, { error: 'POST required' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Request too large'); }
      const params = JSON.parse(body || '{}');
      if(scoped){
        if(!['/inbox','/delegate','/message','/reply','/result','/team','/nodes/manager','/members/manager'].includes(req.url))return reply(403,{error:'Not a runtime capability'});
        params.from=actor.agentId;params.fromSessionKey=actor.sessionKey;
        if(req.url==='/inbox'){params.agent=actor.agentId;params.sessionKey=actor.sessionKey;}
        if(req.url==='/delegate'){for(const name of ['originRunId','originMessageId','continuationOfRunId','resultRunIds','peerReturn','runOrigin'])delete params[name];}
      }
      let value;
      switch (req.url) {
        case '/members/self': value = await network.members.self(auth.toString().slice(7), params); break;
        case '/nodes/owner': value = await network.peers.manage(params); break;
        case '/members/owner': value = await directory(params); break;
        case '/nodes/manager':
        case '/members/manager': {
          const employee = network.catalog.get(params.from);
          const run = network.activeRun(params.from, params.fromSessionKey);
          if (!employee?.manager || employee.scope || !run) throw new Error('Only the active local coordinator can query the external directory');
          const nodeAction = req.url === '/nodes/manager';
          if (nodeAction && params.from !== network.members.coordinator()) throw new Error('Only the primary coordinator represents this network');
          if (params.action !== 'query' && !(nodeAction && ['status','send'].includes(params.action))) {
            if (!network.gate.channel?.ownsRun(run))
              throw new Error('A membership decision requires a task from the bound owner');
          }
          value = nodeAction ? await network.peers.manage(params,run) : await directory(params); break;
        }
        case '/channel/owner':
          if(!network.gate.channel?.ownerRequest || params.action!=='request')throw new Error('Channel does not support owner requests');
          value=await network.gate.channel.ownerRequest(params);break;
        case '/maintenance': value = network.gate.command(params.action, network); break;
        case '/catalog': value = network.catalog.list(); break;
        case '/team': value = await (await import('./team-control.mjs')).teamControl(network, params); break;
        case '/delegate': value = await network.delegate(params); break;
        case '/message': value = await network.send(params); break;
        case '/reply': value = await network.replyUser(params); break;
        case '/result': value = await network.getResult(params.runId, params.waitMs, params.from); break;
        case '/inbox': value = network.receive(params.agent, params.event, params.sessionKey); break;
        default: return reply(404, { error: 'Not found' });
      }
      reply(200, value);
    } catch (error) { reply(400, { error: error.message }); }
  });
  let channel;
  async function close() {
    try {
      try { try { await network.federation?.close(); } finally { await channel?.close(); } }
      finally { await closePeer(); await network.peers.writes; await network.close(); }
    } finally {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise(done => server.close(done));
      }
      try { await network.members?.writes; } finally { await release(); }
    }
  }
  try {
    if (saveEndpoint && network.catalog.config.federation?.enabled) {
      const {Federation}=await import('./federation.mjs');
      network.federation=await Federation.open(network,networkId,network.catalog.config.federation);
      network.catalog.federation=network.federation;
    }
    if (saveEndpoint) closePeer = await openPeerSocket(networkId, (key, data) => network.peers.receive(key, data));
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
    const endpoint = { url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid };
    network.endpoint = endpoint;
    channel = await startChannel?.(network);
    await network.federation?.recover();
    if (hold || channel) {
      for (const id of Object.keys(network.catalog.config.agents)) await network.catalog.prepare(network.catalog.get(id));
    }
    if (saveEndpoint) {
      await writeJson(resolve(root, '.local', 'release-control.json'), { url: endpoint.url, pid: process.pid, token: controlToken });
      await writeJson(discoveryFile, { networkId, url: endpoint.url });
      await writeJson(resolve(root, '.local', 'server.json'), endpoint);
    }
    return { network, endpoint, close };
  } catch (error) {
    await close();
    throw error;
  }
}
