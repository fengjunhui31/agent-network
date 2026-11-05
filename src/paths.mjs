import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './portable-io.mjs';
export { readJson, writeJson, within, redact } from './portable-io.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installed = basename(dirname(ROOT)) === 'releases' && existsSync(resolve(ROOT, 'release-manifest.json'));
export const INSTANCE_ROOT = resolve(process.env.LAN_INSTANCE_ROOT || (installed ? dirname(dirname(ROOT)) : ROOT));
export const LOCAL = resolve(INSTANCE_ROOT, '.local');
export function safeId(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid agent id');
  return value;
}
export async function privateEnvironment() {
  const config = await readJson(resolve(LOCAL, 'credentials.json'), {});
  for (const key of ['NEW_API_URL', 'NEW_API_KEY', 'GLM_MODEL', 'DEEPSEEK_MODEL']) {
    if (process.env[`LAN_${key}`]) config[key] = process.env[`LAN_${key}`];
  }
  return config;
}
