import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { networkVersion } from './version.mjs';

const server = new McpServer({ name: 'local-network', version: networkVersion });
async function invoke(method, params) {
  try {
    const response = await fetch(`${process.env.LAN_URL}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LAN_TOKEN}` },
      body: JSON.stringify({ ...params, from: process.env.LAN_AGENT_ID, fromSessionKey: process.env.LAN_SESSION_KEY || undefined }),
      signal: AbortSignal.timeout(method === 'result' ? 35000 : 10000),
    });
    const value = await response.json();
    // Full native events stay in the saved diagnostic record, outside model context.
    if (method === 'result') { delete value.events; delete value.input; }
    return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: !response.ok };
  } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
}
server.registerTool('delegate', {
  description: '委派工作。target 填成员 ID，或 template:模板名创建临时成员；立即返回 runId。parallel=true 可在同一员工身份与工作区另开独立执行，同群也能并行，是否另开由你判断。',
  inputSchema: { target: z.string(), message: z.string(), files: z.array(z.string()).optional(), parallel: z.boolean().optional() },
}, args => invoke('delegate', args));
server.registerTool('send_message', {
  description: '向成员发送过程消息；主协调者也可向已批准的 node:别名 发送纯文本，由对方网络接收。对方在下一个原生 hook 节点收到；没有目标就返回失败，不重试。files 为本机绝对路径。同一员工有多个执行时，targetRunId 指定本次委派返回的运行 ID。',
  inputSchema: { to: z.string(), message: z.string(), files: z.array(z.string()).optional(), targetRunId: z.string().optional() },
}, ({ targetRunId, ...args }) => invoke('message', { ...args, expectedRunId: targetRunId }));
server.registerTool('get_result', {
  description: '查询一次委派的最终回答、执行状态和产物。waitMs 可短暂等待，最多 30000 毫秒。',
  inputSchema: { runId: z.string(), waitMs: z.number().int().min(0).max(30000).optional() },
}, args => invoke('result', args));
if (process.env.LAN_CAN_REPLY === '1') server.registerTool('reply_user', {
  description: '主控向当前任务来源的用户或群聊发消息。立即入发送队列，可继续执行，不必等任务结束；不用填写收件人。首次调用后，本轮所有后续对外文字也用此工具发送，最终输出仅作内部记录。入队不等于已送达。',
  inputSchema: { message: z.string().trim().min(1).max(6000) },
}, args => invoke('reply', args));
await server.connect(new StdioServerTransport());
