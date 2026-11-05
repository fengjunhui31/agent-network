import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeJson } from '../shared/io.mjs';

export function commandOf(message) {
  const text = message.trim().replace(/^(?:<@[^>]+>\s*)+/, '').replace(/^(?:@\S+\s+)+/, '').replace(/^\//, '');
  return ['启用本群', '停用本群', 'ping', '状态', '停止', '队列', '重试'].includes(text) ? text : null;
}

export async function conversationAgent(catalog, config, body) {
  if (body.chattype === 'group' && !body.chatid) throw new Error('群聊消息缺少 chatid');
  const agent = catalog.get(config.agentId);
  if (!agent) throw new Error('企业微信指定的协调助手不存在');
  return agent;
}

// Keep prior per-group history readable without rewriting or deleting native sessions.
export async function restoreSharedAssistant(network, config, inbox) {
  const legacy = [...inbox.items.values()].filter(item => item.agentId !== config.agentId || item.previousAgentId);
  if (!legacy.length) return;
  const agent = await conversationAgent(network.catalog, config, { chattype: 'single' });
  const entries = [];
  for (const item of legacy.sort((a, b) => a.sequence - b.sequence)) {
    const previousAgentId = item.previousAgentId ?? item.agentId;
    const run = item.runId ? await network.getResult(item.runId).catch(() => null) : null;
    entries.push({ messageId: item.messageId, chatid: item.chatid, chattype: item.body?.chattype,
      receivedAt: item.receivedAt, previousAgentId, workspace: network.catalog.get(previousAgentId)?.workspace,
      message: item.message, answer: run?.answer, status: item.status, files: run?.outputFiles ?? [] });
    if (item.agentId !== agent.id && item.status !== 'completed')
      await inbox.patch(item.id, { agentId: agent.id, previousAgentId });
  }
  await mkdir(resolve(agent.workspace, 'history'), { recursive: true, mode: 0o700 });
  await writeJson(resolve(agent.workspace, 'history/wecom-legacy.json'), { entries });
}
