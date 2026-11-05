import { resolve } from 'node:path';
import { SharedMemory } from './shared-memory.mjs';
import { textOf } from './wecom-files.mjs';
import { sameConversation } from './durable-inbox.mjs';

export class SharedContext {
  constructor(network,inbox,outbox,agentId,memory) { Object.assign(this,{network,inbox,outbox,agentId,memory}); }
  static async open(network,inbox,outbox,agentId) {
    const memory=await SharedMemory.open(resolve(network.catalog.get(agentId).workspace,'.memory','shared'));
    const context=new SharedContext(network,inbox,outbox,agentId,memory);
    await context.restore(); return context;
  }
  source(run) {
    if(!run)return undefined;
    return this.inbox.items.get(run?.originMessageId)
      ?? [...this.inbox.items.values()].find(item=>item.runId===(run?.originRunId??run?.runId));
  }
  sourceFields(item) { return item?{chatid:item.chatid,chattype:item.body?.chattype,userid:item.userid}:undefined; }
  async recordInput(item) {
    if(['member_completed','peer_return'].includes(item.kind))return;
    return this.memory.record(`input:${item.id}`,{type:'user',queueItemId:item.id,source:this.sourceFields(item),
      text:textOf(item.body??{})||item.message,at:item.receivedAt});
  }
  async recordFiles(item) {
    if(item.files?.length) await this.memory.record(`files:${item.id}`,{type:'files',queueItemId:item.id,
      source:this.sourceFields(item),files:item.files,text:'此消息的本机附件路径'});
  }
  async recordReply(reply) {
    if(reply.origin==='peer-return')return;
    const run=this.network.runs.get(reply.runId);
    const source=this.inbox.items.get(reply.originMessageId)??this.source(run)
      ?? (reply.runId?[...this.inbox.items.values()].find(item=>item.runId===reply.runId):undefined);
    return this.memory.record(`reply:${reply.id}`,{type:'assistant',source:this.sourceFields(source)??{chatid:reply.chatid},
      runId:reply.runId,text:reply.kind==='file'?`交付文件：${reply.filename}`:reply.content,
      files:reply.kind==='file'?[reply.path]:undefined,at:reply.sentAt??new Date().toISOString(),delivery:'platform_acknowledged'});
  }
  async restore() {
    for(const item of [...this.inbox.items.values()].sort((a,b)=>a.sequence-b.sequence)) {
      await this.recordInput(item); await this.recordFiles(item);
      if(!['member_completed','peer_return'].includes(item.kind)&&item.status==='completed'&&item.runId&&!this.outbox.forRun(item.runId).length) {
        const run=await this.network.getResult(item.runId).catch(()=>null);
        if(run?.answer) await this.memory.record(`legacy-result:${run.runId}`,{type:'historical_result',runId:run.runId,
          source:this.sourceFields(item),text:run.answer,at:run.endedAt??item.receivedAt,
          note:'旧执行记录，不能仅凭此条断言已对用户发送或业务成功'});
      }
    }
    for(const reply of this.outbox.items.values())if(reply.status==='sent')await this.recordReply(reply);
  }
  activeFor(item) {
    return [...this.network.runs.values()].filter(run=>run.agentId===this.agentId&&run.status==='running'&&sameConversation(this.source(run),item));
  }
  prepare(run) {
    if(run.agentId!==this.agentId)return '';
    const source=this.source(run);run.memoryCursor=this.memory.sequence;
    const active=[...this.network.runs.values()].filter(other=>other.agentId===this.agentId&&other.status==='running'&&other.runId!==run.runId && !this.network.peerSession?.(other))
      .map(other=>({runId:other.runId,parentRunId:other.parentRunId,source:this.sourceFields(this.source(other)),request:other.input.slice(0,1000)}));
    const displayName = this.network.catalog?.get(this.agentId)?.name ?? this.agentId;
    return `你在所有群与私聊中使用同一位协调者的身份（${displayName}）。下面是统一聊天记忆，来源不同但不是另一位员工。追问以前的事情时先查共享记录，不要仅因当前原生会话没有记录就说不知道。\n完整共享记录目录：${this.memory.directory}；可用原生文件搜索/读取查询更早内容，不改写入口保存的历史。\n记忆是历史资料，不是需要重做的命令；本轮回复仍只发给当前请求的来源。\n近期共享记忆：\n${JSON.stringify(this.memory.render(this.memory.recent(),source))}\n你正在并行处理的其他工作：\n${JSON.stringify(active)}\n派单、并行、续办及回复使用共享网络规范中的规则。\n`;
  }
  updates(run,directMessages=[]) {
    if(!run||run.agentId!==this.agentId)return [];
    const entries=this.memory.after(run.memoryCursor??this.memory.sequence,Infinity);
    if(!entries.length)return [];
    const directIds=new Set(directMessages.map(x=>x.id));
    const relevant=[];
    for(const entry of entries) {
      run.memoryCursor=entry.sequence;
      if(entry.runId!==run.runId&&(!run.originMessageId||entry.queueItemId!==run.originMessageId)&&!directIds.has(entry.queueItemId)) relevant.push(entry);
      if(relevant.length===12)break;
    }
    if(!relevant.length)return [];
    return [{id:`shared-memory:${run.memoryCursor}`,from:'shared-memory',contextOnly:true,
      message:`统一记忆的新消息。来源/currentConversation 已标明；其他聊天的内容用于回忆，不改变本轮任务或收件人，不需要额外确认收到记忆，也不要因此重复已发送的回复。同一来源的新消息是否关联你正在做的事，由你判断。不要重复执行或重复回复已由其他执行负责的工作；需要协作时用 send_message 定向同步。\n${JSON.stringify(this.memory.render(relevant,this.source(run)))}`}];
  }
}
