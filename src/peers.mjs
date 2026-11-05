import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from './paths.mjs';
import { callPeer, networkId } from './peer-transport.mjs';

const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const label = z.string().trim().min(1).max(100).refine(s=>!/[\x00-\x1f\x7f]/.test(s));
const message = z.string().trim().min(1).max(6000);
const application = z.object({ id:alias, remoteAlias:alias, name:label }).strict();
const packet = z.object({ from:networkId,to:networkId,linkId:z.string().uuid(),
  action:z.enum(['apply','status','notice','message']),data:z.object({}).passthrough() }).strict();
const textPacket = z.object({text:message,ticket:z.string().uuid().optional(),replyTo:z.string().uuid().optional()}).strict()
  .refine(p=>!(p.ticket && p.replyTo),'Choose either a new conversation or a reply');
const inactive = state => ['left','revoked','rejected'].includes(state);
const fileFor = root => resolve(root,'.local/network-links.json');
const fresh = () => ({version:1,links:{}});
function view(link) {
  return { mode:'network', address:'node:'+link.id, name:link.name, networkId:link.networkId,
    direction:link.direction,status:link.status,updatedAt:link.updatedAt };
}
export async function peerSummary(root, manager = true) {
  if (!manager) return [];
  const state=await readJson(fileFor(root),fresh());
  return Object.values(state.links).filter(l=>!inactive(l.status)).map(view);
}
function compatible(a,b) {
  return !inactive(a.status) && !inactive(b.status) && a.direction !== b.direction
    && (a.direction === 'incoming' ? a.status === 'approved' : b.status === 'approved');
}
function reserveAlias(links, remote, id) {
  if (!Object.hasOwn(links,remote) && Object.keys(links).length>=512) throw new Error('Network contact directory is full');
  if (Object.values(links).some(l=>l.networkId!==remote && !inactive(l.status) && l.id===id)) throw new Error('Node address already in use');
}
export class NetworkPeers {
  constructor(network) {
    this.network=network; this.file=fileFor(network.root);this.writes=Promise.resolve();
    this.tickets=new Map();
    network.on('settled',run=>{
      for(const [id,route] of this.tickets) if(route.runId===run.runId) this.tickets.delete(id);
    });
  }
  async read() { await this.writes;return readJson(this.file,fresh()); }
  edit(fn) {
    const task=this.writes.then(async()=>{
      const state=await readJson(this.file,fresh());
      const value=fn(state.links);
      await writeJson(this.file,state);return value;
    });
    this.writes=task.catch(()=>{});return task;
  }
  async find(id) {
    const links=Object.values((await this.read()).links).filter(l=>l.id===alias.parse(id));
    const found=links.find(l=>!inactive(l.status)) ?? links.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    if(!found) throw new Error('Unknown communication node');
    return found;
  }
  wire(link, action, data) { return callPeer(link.networkId,this.id,link,action,data); }
  async authenticated(from, linkId, secret) {
    const link=(await this.read()).links[from];
    if(!link || link.linkId!==linkId || !timingSafeEqual(Buffer.from(link.secret,'hex'),Buffer.from(secret,'hex')))
      throw new Error('Unknown link or credential');
    return link;
  }
  async join({peer,id,remoteAlias,name,consent}) {
    if(this.network.federation && (await this.network.federation.list()).some(l=>l.networkId===peer||l.id===remoteAlias))throw new Error('An authenticated federation contact already owns this identity or alias');
    if(consent!==true) throw new Error('The joining network must give explicit consent');
    networkId.parse(peer);
    if(peer===this.id) throw new Error('Choose a different network');
    const form=application.parse({id,remoteAlias,name});
    const entry=await this.edit(links=>{
      const current=links[peer];reserveAlias(links,peer,remoteAlias);
      if(current && !inactive(current.status)) {
        if(current.direction!=='outgoing' || current.id!==form.remoteAlias || current.remoteAlias!==form.id || current.offerName!==form.name)
          throw new Error('This network already has one node for that peer; inspect or leave the existing link');
        return current;
      }
      const link={networkId:peer,id:form.remoteAlias,remoteAlias:form.id,offerName:form.name,name:form.remoteAlias,
        direction:'outgoing',status:'pending',linkId:randomUUID(),secret:randomBytes(32).toString('hex'),updatedAt:new Date().toISOString()};
      links[peer]=link;return link;
    });
    const result=await this.wire(entry,'apply',form);
    return this.observe(entry,result.status);
  }
  async observe(link,status) {
    if(!['pending','approved','left','revoked','rejected'].includes(status)) throw new Error('Invalid peer state');
    return this.edit(links=>{
      const current=links[link.networkId];
      if(!current || current.linkId!==link.linkId) throw new Error('Node relationship changed');
      if(!inactive(current.status) && (inactive(status) || (current.direction==='outgoing' && status==='approved'))) {
        if(current.status!==status){current.status=status;current.updatedAt=new Date().toISOString();}
      }
      return view(current);
    });
  }
  async receive(secret,raw) {
    const {from,to,linkId,action,data}=packet.parse(raw);
    if(this.network.federation && Object.hasOwn((await this.network.federation.store.read()).contacts,from))throw new Error('Pinned network requires authenticated federation');
    if(to!==this.id || from===to) throw new Error('Wrong network identity');
    if(action==='apply') {
      const form=application.parse(data);
      const remote={networkId:from,secret,linkId};
      const confirmed=await this.wire(remote,'status');
      if(confirmed.direction!=='outgoing' || inactive(confirmed.status) || confirmed.offeredId!==form.id || confirmed.returnAlias!==form.remoteAlias)
        throw new Error('Joining network did not confirm this application');
      return this.edit(links=>{
        const old=links[from];reserveAlias(links,from,form.id);
        if(old?.linkId===linkId) {
          if(old.secret!==secret || old.direction!=='incoming' || old.id!==form.id || old.name!==form.name) throw new Error('Conflicting node application');
          return {status:old.status};
        }
        // A verified fresh outgoing request supersedes an old incoming grant, including
        // a withdrawal we missed offline. It always needs a new local approval.
        if(old?.direction==='outgoing' && !inactive(old.status)) {
          if(old.status!=='pending' || this.id < from) throw new Error('An outgoing link already exists for this network; inspect the existing node');
        }
        links[from]={...remote,id:form.id,name:form.name,remoteAlias:form.remoteAlias,direction:'incoming',status:'pending',updatedAt:new Date().toISOString()};
        return {status:'pending'};
      });
    }
    const link=await this.authenticated(from,linkId,secret);
    if(action==='status') return {direction:link.direction,status:link.status,offeredId:link.remoteAlias,returnAlias:link.id};
    if(action==='notice') {
      // Read authoritative state, so a delayed notice cannot reopen a revoked relationship.
      const remote=await this.wire(link,'status');
      return {status:(await this.observe(link,remote.status)).status};
    }
    const text=textPacket.parse(data);
    if(inactive(link.status)) throw new Error('Communication node is closed');
    const remote=await this.wire(link,'status');
    if(!compatible(link,remote)) throw new Error('Both networks must consent and the receiver must approve');
    const latest=await this.authenticated(from,linkId,secret);
    if(!compatible(latest,remote)) throw new Error('Communication node is closed');
    return this.deliver(latest,text);
  }
  async inspect(id) {
    const link=await this.find(id);
    let remote;
    try {remote=await this.wire(link,'status');}
    catch(e){return {...view(link),contacted:false,detail:e.message};}
    const observed=await this.observe(link,remote.status);
    return {...observed,contacted:true,canMessage:compatible({...link,status:observed.status},remote)};
  }
  async decide(id,action) {
    const selected=await this.find(id);
    const link=await this.edit(links=>{
      const current=links[selected.networkId];if(current.linkId!==selected.linkId) throw new Error('Node relationship changed');
      const states={approve:'approved',reject:'rejected',revoke:'revoked',leave:'left'};
      const next=states[action];
      if(!next || (action!=='leave' && current.direction!=='incoming')) throw new Error('Only the receiving network decides on the application');
      if(current.status!==next) {
        if((['approve','reject'].includes(action) && current.status!=='pending') || (action==='revoke' && current.status!=='approved'))
          throw new Error('This decision does not apply to the current node state');
        current.status=next;current.updatedAt=new Date().toISOString();
      }
      return current;
    });
    let notified=true;
    try {await this.wire(link,'notice');} catch {notified=false;}
    return {...view(link),peerNotified:notified};
  }
  async transmit(id,text,run) {
    const secure=await this.network.federation?.find(id);
    if(secure) return this.network.federation.transmit(secure,text,run);
    message.parse(text);
    const link=await this.find(id);
    if(inactive(link.status) || (link.direction==='incoming' && link.status!=='approved')) throw new Error('Communication node is not approved');
    const source=this.network.peerSession(run);
    const peerPrefix='peer:'+link.networkId+':'+link.linkId+':';
    if(source && !source.startsWith(peerPrefix)) throw new Error('A peer conversation may reply only through its original link');
    const replyTo=source?.slice(peerPrefix.length);
    let ticket;
    if(run && !source) {
      ticket=[...this.tickets.entries()].find(([,r])=>r.runId===run.runId && r.linkId===link.linkId)?.[0];
      if(!ticket){ticket=randomUUID();this.tickets.set(ticket,{linkId:link.linkId,runId:run.runId,agent:run.agentId,sessionKey:run.sessionKey});}
    }
    const result=await this.wire(link,'message',{text,...(ticket?{ticket}:{}),...(replyTo && replyTo!=='general'?{replyTo}:{})});
    return {accepted:result.accepted===true,address:'node:'+link.id};
  }
  async deliver(link,{text,ticket,replyTo}) {
    const network=this.network;
    const alias='node:'+link.id;
    const target=network.members.coordinator();
    if(!target) throw new Error('Peer has no local coordinator');
    const route=replyTo ? this.tickets.get(replyTo) : null;
    if(route?.linkId===link.linkId && network.activeRun(route.agent,route.sessionKey)?.runId===route.runId) {
      try {
        await network.send({to:route.agent,from:alias,message:text,expectedRunId:route.runId});
        return {accepted:true};
      } catch (error) {if(network.activeRun(route.agent,route.sessionKey)?.runId===route.runId) throw error;}
    }
    const sessionKey='peer:'+link.networkId+':'+link.linkId+':'+(ticket ?? 'general');
    const body=`来自通信节点 ${alias} 的外部协作消息：\n${text}`;
    await network.send({to:target,from:alias,sessionKey,message:body});
    return {accepted:true};
  }
  async manage(params,run) {
    if(!this.id && !['query','pending'].includes(params.action)) throw new Error('This service has no active peer endpoint');
    const fed=this.network.federation;
    if(['identity','relay-status','invite','inbox','returns','reply'].includes(params.action) || (params.action==='join'&&params.invitation)){
      if(!fed) throw new Error('Federation is not enabled in this instance');
      return fed.manage(params);
    }
    const contact=params.id && fed && params.action!=='join' ? await fed.find(params.id) : null;
    if(contact && params.action==='send')return fed.transmit(contact,params.message,run,undefined,params.messageId);
    if(contact && params.action==='query')return (await fed.list()).filter(l=>l.id===params.id);
    if(contact)return fed.manage(params);
    if(fed && ['query','pending'].includes(params.action)){
      const links=[...await peerSummary(this.network.root),...await fed.list()];
      return params.action==='pending'?links.filter(l=>l.direction==='incoming'&&l.status==='pending'):links;
    }
    switch(params.action) {
      case 'join': return this.join(params);
      case 'query': return peerSummary(this.network.root);
      case 'pending': return (await peerSummary(this.network.root)).filter(l=>l.direction==='incoming' && l.status==='pending');
      case 'status': return this.inspect(params.id);
      case 'send': return this.transmit(params.id,params.message,run);
      default: return this.decide(params.id,params.action);
    }
  }
}
