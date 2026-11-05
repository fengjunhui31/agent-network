import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function sessionTag(sessionKey) {
  if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 512) throw new Error('Invalid conversation session key');
  return createHash('sha256').update(sessionKey).digest('hex');
}
export function executionKey(agentId, sessionKey) {
  return sessionKey ? `${agentId}:${sessionTag(sessionKey)}` : agentId;
}
export function sessionAgent(agent, sessionKey) {
  return sessionKey ? { ...agent, sessionKey, sharedConfigDirectory: agent.configDirectory,
    configDirectory: resolve(agent.configDirectory, 'conversations', sessionTag(sessionKey)) } : agent;
}
