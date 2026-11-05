import { executionKey } from '../shared/keys.mjs';
export { sessionTag } from '../shared/keys.mjs';

export function conversationSession(item) {
  return item.sessionKey ?? `wecom:${item.body?.chattype ?? 'single'}:${item.chatid ?? item.userid ?? item.agentId}`;
}
export function conversationKey(item) { return executionKey(item.agentId, conversationSession(item)); }
