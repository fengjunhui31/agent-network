import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { ROOT, INSTANCE_ROOT, LOCAL, readJson, writeJson, privateEnvironment } from './paths.mjs';

export async function runtimeInstallation(name) {
  const versions = await readJson(resolve(ROOT, 'runtime-versions.json'));
  const state = await readJson(process.env.LAN_RUNTIME_STATE_FILE ?? resolve(LOCAL, 'runtime-state.json'), {});
  const slot = state[name]?.active ?? 'initial';
  const directory = resolve(LOCAL, 'runtimes', name, slot);
  return { directory, slot, ...versions[name], ...(state[name]?.spec ?? {}) };
}

export async function runtimeConfig(agent, endpoint, credentialsOverride) {
  const credentials = credentialsOverride ?? await privateEnvironment();
  const installation = await runtimeInstallation(agent.runtime);
  const model = agent.model ?? credentials[agent.modelEnv];
  const requestHeaders = Object.fromEntries(Object.entries(agent.requestHeaders ?? {}).map(([name, value]) => [name, String(value).replaceAll('{agentId}', agent.id)]));
  new Headers(requestHeaders); // Reject invalid header names or values before starting a runtime.
  if (!model || !credentials.NEW_API_KEY || !credentials.NEW_API_URL) {
    throw new Error(`Configure NEW_API_URL, NEW_API_KEY and ${agent.modelEnv} in .local/credentials.json`);
  }
  const env = { ...process.env };
  // Isolate model routes; user-wide runtime secrets must not win precedence.
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|DEEPSEEK_|DSH_|OPENAI_|LAN_)/.test(key)) delete env[key];
  }
  Object.assign(env, { LAN_INSTANCE_ROOT: agent.instanceRoot ?? INSTANCE_ROOT, LAN_URL: endpoint.url, LAN_TOKEN: endpoint.token, LAN_AGENT_ID: agent.id, LAN_CAN_REPLY: (agent.canReply ?? agent.manager) ? '1' : '0', LAN_HOST_MANAGER: agent.hostManager ? '1' : '0', LAN_SESSION_KEY: agent.sessionKey ?? '' });
  const endpointFile = resolve(agent.configDirectory, 'network-endpoint.json');
  await writeJson(endpointFile, { ...endpoint, agentId: agent.id, sessionKey: agent.sessionKey });
  env.LAN_ENDPOINT_FILE = endpointFile;
  const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;
  // DSH scrubs credential-shaped environment variables from hook subprocesses.
  // Supply our local capability via a private file; never put its value in a command.
  // Shared Claude project settings must not embed one conversation's endpoint.
  // Claude inherits the per-process endpoint file; DSH uses its private profile.
  const hookCommand = [process.execPath, resolve(ROOT, 'src/hook.mjs'), ...(agent.runtime === 'claude' ? [] : [endpointFile])].map(quote).join(' ');
  const hooks = Object.fromEntries(['UserPromptSubmit', 'PostToolUse', 'Stop'].map(event => [event, [
    { matcher: '.*', hooks: [{ type: 'command', command: hookCommand, timeout: 3 }] },
  ]]));
  const hookFile = resolve(agent.configDirectory, 'hooks.json');
  await writeJson(hookFile, { hooks });
  const bin = resolve(installation.directory, 'node_modules', '.bin', installation.bin);
  let args = [];
  if (agent.runtime === 'claude') {
    const configDir = resolve(agent.configDirectory, 'claude');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeJson(resolve(agent.workspace, '.claude', 'settings.json'), { hooks });
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_EXECUTABLE: resolve(installation.directory, 'node_modules/.bin/claude'),
      ANTHROPIC_BASE_URL: credentials.NEW_API_URL.replace(/\/v1\/?$/, ''),
      ANTHROPIC_AUTH_TOKEN: credentials.NEW_API_KEY,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // Keep the small collaboration/reply tool set immediately available through all gateways.
      ENABLE_TOOL_SEARCH: 'false',
      MCP_CONNECTION_NONBLOCKING: '0',
      DISABLE_AUTOUPDATER: '1',
    });
    if (Object.keys(requestHeaders).length) env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`).join('\n');
  } else if (agent.runtime === 'dsh') {
    const home = resolve(agent.configDirectory, 'dsh');
    const profile = resolve(home, 'profiles', 'acp');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeJson(join(profile, 'package.json'), {
      private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } },
    });
    const provider = {
      displayName: 'New API / DeepSeek', apiKeyEnv: 'LAN_MODEL_KEY', api: 'openai-completions',
      headers: requestHeaders,
      baseURL: `${credentials.NEW_API_URL.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/v1`,
      compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' },
      models: [{ id: model, name: model, contextWindow: 1000000, maxTokens: 8192,
        reasoningEfforts: { off: null, high: 'high' } }],
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    };
    const patch = [
      { id: 'llm-pi-ai', config: { providers: { 'local-newapi': provider } } },
      { id: 'agent-default-model', config: { provider: 'local-newapi', model } },
      { id: 'acp', config: { provider: 'local-newapi', model } },
      // Profile modules resolve from the profile directory, not the dsh binary's installation.
      { insert: [{ id: 'network-hooks', name: resolve(installation.directory, 'node_modules/@deepseek-ai/dsh-hooks-claude-code/lib/index.js'),
        config: { configPath: hookFile, projectDir: agent.workspace, defaultTimeoutMs: 3000 } }] },
    ];
    // JSON is valid YAML and keeps generated paths/strings escaped exactly.
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2));
    Object.assign(env, { DSH_HOME: home, LAN_MODEL_KEY: credentials.NEW_API_KEY, DSH_DISABLE_TELEMETRY: '1' });
    args = ['--profile', 'acp'];
  } else throw new Error(`Unsupported runtime: ${agent.runtime}`);
  const mcpServers = [{ name: 'local-network', command: process.execPath,
    args: [resolve(ROOT, 'src/mcp.mjs')], env: ['LAN_URL', 'LAN_TOKEN', 'LAN_AGENT_ID', 'LAN_CAN_REPLY', 'LAN_HOST_MANAGER', 'LAN_SESSION_KEY'].map(name => ({ name, value: env[name] })) }];
  return { bin, args, env, model, mcpServers, installation, secrets: [credentials.NEW_API_KEY, endpoint.token] };
}
