// Deterministic protocol fixture. It is never presented as a real model test.
import http from 'node:http';

function toolResponse(body, tool, args, text) {
  const content = tool ? [{ type: 'tool_use', id: `tool_${crypto.randomUUID()}`, name: tool, input: args }] : [{ type: 'text', text }];
  return { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
    content, stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 40 } };
}
function anthropic(res, body, tool, args, text) {
  const message = toolResponse(body, tool, args, text);
  if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
  res.setHeader('content-type', 'text/event-stream');
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  send({ type: 'content_block_start', index: 0, content_block: tool ? { ...message.content[0], input: {} } : { type: 'text', text: '' } });
  send({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } });
  send({ type: 'content_block_stop', index: 0 });
  send({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 40 } });
  send({ type: 'message_stop' }); res.end();
}
function openai(res, body, tool, args, text) {
  const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${crypto.randomUUID()}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: text };
  const base = { id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model: body.model };
  const finish_reason = tool ? 'tool_calls' : 'stop';
  if (!body.stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } })); return;
  }
  res.setHeader('content-type', 'text/event-stream');
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  send(tool ? { ...message, tool_calls: message.tool_calls.map(x => ({ index: 0, ...x })) } : message);
  send({}, finish_reason); res.end('data: [DONE]\n\n');
}

export async function startMockModel() {
  const state = { calls: [], nonce: '', delivered: false };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url?.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":100}'); return; }
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"glm-hook-test"},{"id":"deepseek-hook-test"}]}'); return; }
    try {
      const body = JSON.parse(raw);
      // Claude may finish background summary requests after its test has ended.
      if (body.model !== state.model) {
        if (req.url?.includes('/messages')) anthropic(res, body, undefined, undefined, 'background summary');
        else openai(res, body, undefined, undefined, 'background summary');
        return;
      }
      const tools = (body.tools ?? []).map(x => x.function ?? x);
      const visible = JSON.stringify(body.messages);
      const seen = visible.includes(state.nonce);
      const toolOutput = JSON.stringify((body.messages ?? []).filter(x => x.role === 'tool' || (Array.isArray(x.content) && x.content.some(y => y.type === 'tool_result'))));
      if (state.resultRequested && toolOutput.includes(state.resultRunId) && toolOutput.includes('running')) state.resultSeen = true;
      state.calls.push({ path: req.url, model: body.model, tools: tools.map(x => x.name), nonceSeen: seen });
      let selected; let args;
      if (!seen && !state.delivered) {
        selected = tools.find(x => /bash|shell|exec/i.test(x.name) && (x.input_schema ?? x.parameters)?.properties?.command);
        if (!selected) throw new Error(`No native command tool found: ${tools.map(x => x.name).join(', ')}`);
        args = { command: `node -e 'require("fs").writeFileSync("native-ready.txt","ready");setTimeout(()=>{},3000)'`, description: 'Native hook verification', timeout: 10000 };
        state.delivered = true;
      } else if (seen && !state.resultRequested) {
        selected = tools.find(x => x.name.startsWith('mcp') && x.name.endsWith('get_result'));
        if (selected) { args = { runId: state.resultRunId }; state.resultRequested = true; }
      }
      const text = seen ? `NATIVE_HOOK_SEEN:${state.nonce}` : 'NATIVE_HOOK_MISSING';
      if (req.url?.includes('/messages')) anthropic(res, body, selected?.name, args, text);
      else if (req.url?.includes('/chat/completions')) openai(res, body, selected?.name, args, text);
      else { res.statusCode = 404; res.end('{}'); }
    } catch (error) { state.error = error.message; res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message, type: 'server_error' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
