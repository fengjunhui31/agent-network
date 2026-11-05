import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile, link, rm, realpath, stat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { INSTANCE_ROOT, readJson } from '../src/paths.mjs';
import { codexReport, projectScripts } from '../src/codex-discovery.mjs';
import { application, projectReport } from '../src/members.mjs';

const { values:o, positionals } = parseArgs({allowPositionals:true,options:{
  mode:{type:'string'},peer:{type:'string'},alias:{type:'string'},message:{type:'string'},
  id:{type:'string'},name:{type:'string'},runtime:{type:'string'},project:{type:'string',multiple:true},report:{type:'string'},
  card:{type:'string'},invite:{type:'string'},preapprove:{type:'boolean'},'request-id':{type:'string'},'message-id':{type:'string'},
  consent:{type:'boolean'},agent:{type:'string'},search:{type:'string'},instance:{type:'string'},
}});
const [action='help'] = positionals;
const instance = resolve(o.instance ?? INSTANCE_ROOT);
const local = resolve(instance,'.local');
function id() {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(o.id ?? '')) throw new Error('Provide --id with a lowercase member ID');
  return o.id;
}
async function selected() {
  return Promise.all((o.project ?? []).map(async p => {
    const canonical = await realpath(resolve(p));
    if (!(await stat(canonical)).isDirectory()) throw new Error('Choose an existing project directory');
    return canonical;
  }));
}
async function call(ep, route, data) {
  const url = new URL(ep.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('This client connects only to the local network');
  const response = await fetch(new URL(route,url), {method:data ? 'POST' : 'GET',
    headers:{'content-type':'application/json',...(ep.token ? {authorization:'Bearer '+ep.token} : {})},
    body:data ? JSON.stringify(data) : undefined,signal:AbortSignal.timeout(15000)});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed');
  return value;
}
async function credential(networkId, memberId, create) {
  if (!/^[0-9a-f-]{36}$/.test(networkId)) throw new Error('Invalid local network identity');
  const base = process.env.AGENT_NETWORK_MEMBER_HOME ?? resolve(homedir(),'.local/share/agent-network/members');
  const file = resolve(base,networkId,memberId+'.key');
  if (create) {
    await mkdir(dirname(file),{recursive:true,mode:0o700});
    const tmp = file+'.'+randomUUID();
    try {
      await writeFile(tmp,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
      try { await link(tmp,file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    } finally { await rm(tmp,{force:true}); }
  }
  try { return (await readFile(file,'utf8')).trim(); }
  catch { throw new Error('Member credential is missing; join from the original local profile'); }
}
async function reports(roots, runtime, fn) {
  if (o.report) {
    const input = await readJson(resolve(o.report));
    const rows = (Array.isArray(input) ? input : [input]).map(r => projectReport.parse(r));
    if (rows.some(r => !roots.includes(r.project)) || new Set(rows.map(r=>r.project)).size !== rows.length)
      throw new Error('Each report must belong to a distinct selected project');
    for (const row of rows) await fn(row);
    return;
  }
  for (const project of roots) {
    let report;
    if (runtime === 'codex') report = await codexReport(project);
    else {
      const scripts = await projectScripts(project);
      report = {project,sessions:[],tools:scripts.tools.slice(0,1200),partial:[...scripts.partial,'sessions-unreported',...(scripts.tools.length > 1200 ? ['tools-limited'] : [])]};
    }
    await fn(projectReport.parse(report));
  }
}
async function run() {
  if (action === 'help') return 'identity | relay-status | invite --card FILE [--preapprove] | join --mode network --invite FILE --id MY_ALIAS --alias THEIR_ALIAS --consent | inbox/returns --id node:ALIAS | reply --id node:ALIAS --request-id UUID --message TEXT | join --mode network --peer OTHER_INSTANCE --id MY_NODE --alias THEIR_NODE --consent | send --id node:ALIAS --message TEXT | guide | discover --runtime codex --project DIR | join --id ID --runtime NAME --project DIR --consent | sync/status/leave --id ID | pending | approve/reject/revoke --id ID | query [--search WORD] [--id ID] [--project DIR]';
  if (o.mode && !['network','member'].includes(o.mode)) throw new Error('Choose --mode member or network');
  if ((action === 'join' && o.mode !== 'network' && (o.peer || o.alias || o.id?.startsWith('node:'))) ||
      (o.mode === 'member' && o.id?.startsWith('node:'))) throw new Error('Choose --mode network explicitly to join as a main network');
  if(['identity','relay-status','invite','inbox','returns','reply'].includes(action) || (action==='join' && o.invite)){
    if(process.env.LAN_AGENT_ID)throw new Error('Use the owner CLI to manage federation identities, invitations and received data');
    const ep=await readJson(resolve(local,'release-control.json'));
    const file=async path=>path?readJson(await realpath(resolve(path))):undefined;
    return call(ep,'/nodes/owner',{action,id:o.id?.replace(/^node:/,''),remoteAlias:o.alias,name:o.name??o.id,consent:o.consent,
      invitation:await file(o.invite),card:await file(o.card),preapprove:o.preapprove===true,
      message:o.message,messageId:o['message-id'],requestId:o['request-id']});
  }
  if (action !== 'guide' && (o.mode === 'network' || o.id?.startsWith('node:'))) {
    if (o.project || o.runtime || o.report || o.agent) throw new Error('Network mode exposes one text node and does not use projects, reports or employee bindings');
    if (!['join','query','pending','status','send','approve','reject','revoke','leave'].includes(action)) throw new Error('Unknown network node command');
    const managed = Boolean(process.env.LAN_AGENT_ID);
    const ep = managed ? {url:process.env.LAN_URL,token:process.env.LAN_TOKEN} : await readJson(resolve(local,'release-control.json'));
    let peer;
    if (action==='join') {
      if (!o.peer || !o.consent || !o.id || !o.alias) throw new Error('Network join requires --peer, --id, --alias and --consent');
      peer = /^[0-9a-f-]{36}$/.test(o.peer) ? o.peer : (await readJson(resolve(o.peer,'.local/join.json'))).networkId;
    }
    const id = o.id?.replace(/^node:/,'');
    return call(ep,managed ? '/nodes/manager':'/nodes/owner',{action,id,name:o.name ?? id,remoteAlias:o.alias,peer,consent:o.consent,message:o.message,
      ...(managed ? {from:process.env.LAN_AGENT_ID,fromSessionKey:process.env.LAN_SESSION_KEY || undefined} : {})});
  }
  if (action === 'discover') {
    const roots = await selected(); if (!roots.length) throw new Error('Select at least one --project');
    const result = []; await reports(roots,o.runtime ?? 'codex',r => result.push(r)); return result;
  }
  const discovery = await readJson(resolve(local,'join.json'));
  if (action === 'guide') {
    const info = await call(discovery,'/join');
    return `网络 ${info.networkId} · 主协调者 ${info.coordinator}
本机客户端 ${info.client}

${info.guide}`;
  }
  if (['query','pending','approve','reject','revoke'].includes(action)) {
    const managed = Boolean(process.env.LAN_AGENT_ID);
    const ep = managed ? {url:process.env.LAN_URL,token:process.env.LAN_TOKEN} : await readJson(resolve(local,'release-control.json'));
    if ((o.project ?? []).length > 1) throw new Error('Query one project at a time');
    const filteredProject = o.project?.length ? resolve(o.project[0]) : undefined;
    return call(ep,managed ? '/members/manager' : '/members/owner',{action,id:o.id,agent:o.agent,project:filteredProject,query:o.search,
      ...(managed ? {from:process.env.LAN_AGENT_ID,fromSessionKey:process.env.LAN_SESSION_KEY || undefined} : {})});
  }
  if (!['join','sync','status','leave'].includes(action)) throw new Error('Unknown member command');
  const memberId = id();
  const roots = await selected();
  let form;
  if (action === 'join') form = application.parse({id:memberId,name:o.name ?? memberId,runtime:o.runtime,projects:roots,consent:o.consent === true});
  const ep = {...discovery,token:await credential(discovery.networkId,memberId,action==='join')};
  const self = (action, fields={}) => call(ep,'/members/self',{action,id:memberId,...fields});
  const state = await self(action === 'sync' ? 'status' : action,form ? {application:form} : {});
  if (!['join','sync'].includes(action)) return state;
  if (!['pending','approved'].includes(state.status)) throw new Error('The member has no active application');
  const scope = roots.length ? roots : state.projects;
  if (scope.some(p => !state.projects.includes(p))) throw new Error('Project is outside the agreed scope');
  const sent=[];
  try { await reports(scope,state.runtime,async report => sent.push(await self('report',{report}))); }
  catch (error) { throw new Error(`${memberId} is ${state.status}; ${sent.length} project report(s) saved. Run sync again to refresh: ${error.message}`); }
  return {member:state,reports:sent};
}
try {
  const result = await run();
  console.log(typeof result === 'string' ? result : JSON.stringify(result,null,2));
} catch (e) { console.error(e.message); process.exitCode=1; }
