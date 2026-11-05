import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WecomBridge } from '../src/wecom.mjs';
import { fixture } from '../../../test/network-fixture.mjs';
import { ROOT } from '../../../src/paths.mjs';
import { executionKey } from '../../../src/sessions.mjs';
test('a coordinator can start parallel work through MCP in the same chat and reply there after the parent turn ends', async t => {
  const {network,service,controls,root}=await fixture(t);await network.catalog.update('a',{manager:true});
  const messages=[];
  class Transport extends EventEmitter {
    connect(){this.emit('authenticated');}disconnect(){}
    async sendMessage(chatid,body){messages.push({chatid,text:body.markdown.content});return {errcode:0};}
    async replyStream(){return {errcode:0};}
  }
  const bridge=new WecomBridge(network,new Transport(),{agentId:'a',allowedUserIds:['owner']},
    {configFile:resolve(root,'wecom.json'),statusFile:resolve(root,'status.json'),logFile:resolve(root,'events.jsonl'),inboxDirectory:resolve(root,'inbox')}).start();
  await bridge.ready;
  let caller;
  try {
    const ready=once(network,'event');await bridge.receive({body:{msgid:'parent',chattype:'group',chatid:'group-a',from:{userid:'owner'},msgtype:'text',text:{content:'parallel work'}}});await ready;
    const parent=[...network.runs.values()][0];
    caller=new Client({name:'parallel-self',version:'1'});
    await caller.connect(new StdioClientTransport({command:process.execPath,args:[resolve(ROOT,'src/mcp.mjs')],env:{...process.env,
      LAN_URL:service.endpoint.url,LAN_TOKEN:service.endpoint.token,LAN_AGENT_ID:'a',LAN_SESSION_KEY:parent.sessionKey,LAN_CAN_REPLY:'1'}}));
    const childReady=once(network,'event');
    const response=await caller.callTool({name:'delegate',arguments:{target:'a',parallel:true,message:'second independent task'}});
    assert.equal(response.isError,false);const childId=JSON.parse(response.content[0].text).runId;await childReady;
    const child=network.runs.get(childId);
    assert.equal(child.agentId,parent.agentId);assert.equal(child.workspace,parent.workspace);assert.notEqual(child.sessionKey,parent.sessionKey);
    assert.equal(child.originMessageId,parent.originMessageId);assert.equal(network.busy.size,2);
    await caller.callTool({name:'send_message',arguments:{to:'a',targetRunId:child.runId,message:'targeted update'}});
    assert.equal(network.receive('a','PostToolUse',child.sessionKey).messages[0].message,'targeted update');
    controls.get(executionKey('a',parent.sessionKey)).finish({answer:'parent done',stopReason:'end_turn'});await parent.settled;await bridge.worker.running;
    await network.replyUser({from:'a',fromSessionKey:child.sessionKey,message:'parallel child result'});
    await bridge.outbox.running;
    assert.equal(messages.find(x=>x.text==='parallel child result').chatid,'group-a');
    assert.equal(bridge.context.activeFor({chatid:'group-a',body:{chattype:'group'}}).length,1);
    controls.get(executionKey('a',child.sessionKey)).finish({answer:'internal',stopReason:'end_turn'});await child.settled;
    assert.equal(network.runtimes.has(executionKey('a',child.sessionKey)),false);
    assert.equal(network.runtimes.has(executionKey('a',parent.sessionKey)),true);
  } finally {await caller?.close();await bridge.close();}
});
