import { privateEnvironment, redact } from '../src/paths.mjs';

const config = await privateEnvironment();
try {
  if (!config.NEW_API_URL || !config.NEW_API_KEY) throw new Error('Configure NEW_API_URL and NEW_API_KEY first');
  const base = config.NEW_API_URL.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const response = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${config.NEW_API_KEY}` }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Gateway model listing failed: HTTP ${response.status}`);
  const body = await response.json();
  const models = (body.data ?? []).map(x => x.id);
  const configured = Object.fromEntries(['GLM_MODEL', 'DEEPSEEK_MODEL'].map(key => [key, {
    model: config[key] ?? null, listed: Boolean(config[key] && models.includes(config[key])),
  }]));
  console.log(JSON.stringify({ gateway: base, available: models.filter(x => /glm|deepseek/i.test(x)), configured,
    note: 'A listed model is not proof of successful inference or its upstream version; run verify:live and verify the gateway channel mapping.' }, null, 2));
  if (Object.values(configured).some(x => !x.listed)) process.exitCode = 1;
} catch (error) { console.error(redact(error.message, [config.NEW_API_KEY])); process.exitCode = 1; }
