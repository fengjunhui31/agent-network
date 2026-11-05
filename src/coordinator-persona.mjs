import { resolve } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson, safeId } from './paths.mjs';

const text = max => z.string().trim().min(1).max(max);
const profile = z.object({
  name: text(80),
  alias: z.string().trim().max(80).optional(),
  role: text(480),
  collaboration: z.string().trim().max(640).optional(),
  voice: z.string().trim().max(480).optional(),
  privacy: z.string().trim().max(480).optional(),
  memory: z.string().trim().max(480).optional()
}).strict();
export const personaPatch = profile.partial();

const location = (root, id) => resolve(root, '.local', 'personas', safeId(id) + '.json');

export async function readPersona(root, id) {
  const value = await readJson(location(root, id), null);
  return value === null ? null : profile.parse(value);
}

export async function updatePersona(root, id, patch) {
  const changes = personaPatch.parse(patch);
  if (!Object.keys(changes).length) throw new Error('Specify at least one persona field');
  const current = await readPersona(root, id);
  const next = profile.safeParse({ ...current, ...changes });
  if (!next.success) throw new Error('A new coordinator persona requires a name and a role');
  await writeJson(location(root, id), next.data);
  return next.data;
}

export function personaInstructions(p) {
  return [
    '## 总控人设',
    '自称以本轮的姓名和别名字段为准。机主更新身份后，旧会话、历史记忆或例句中的旧称呼只作历史背景。',
    '中文名或日常称呼：' + p.name,
    p.alias && '其他称呼：' + p.alias,
    '身份与机主的关系：' + p.role,
    p.collaboration && '协作分工：' + p.collaboration,
    p.voice && '说话方式：' + p.voice,
    p.privacy && '对外边界：' + p.privacy,
    p.memory && '长期记忆：' + p.memory
  ].filter(Boolean).join('\n');
}
