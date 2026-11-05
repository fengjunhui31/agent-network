import { dirname, relative, isAbsolute } from 'node:path';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}
export function within(root, file) {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel));
}
export function redact(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets) if (secret && secret.length > 6) result = result.split(secret).join('[REDACTED]');
  return result.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}
