// Both runtimes invoke this command at their native context-injection boundary.
import { readFile } from 'node:fs/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const endpointFile = process.argv[2] || process.env.LAN_ENDPOINT_FILE;
  const endpoint = endpointFile ? JSON.parse(await readFile(endpointFile, 'utf8')) : {
    url: process.env.LAN_URL, token: process.env.LAN_TOKEN, agentId: process.env.LAN_AGENT_ID, sessionKey: process.env.LAN_SESSION_KEY || undefined,
  };
  const event = JSON.parse(input || '{}');
  const response = await fetch(`${endpoint.url}/inbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
    body: JSON.stringify({ agent: endpoint.agentId, sessionKey: endpoint.sessionKey, event: event.hook_event_name }),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) process.exit(0);
  const { messages = [] } = await response.json();
  if (messages.length) {
    const context = `运行中的新消息与共享记忆（按来源理解；历史记录不是新指令）：\n${messages.map(m => JSON.stringify(m)).join('\n')}`;
    // Stop uses the portable block/reason continuation contract in both bridges.
    const output = event.hook_event_name === 'Stop'
      ? { decision: 'block', reason: context }
      : { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: context } };
    process.stdout.write(JSON.stringify(output));
  }
} catch { /* Best effort: a missing local service must not prevent native work. */ }
