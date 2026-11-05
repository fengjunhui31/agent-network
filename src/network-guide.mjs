import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './paths.mjs';

// These project documents are shared read-only context across native workspaces.
// Other files in the application or another employee's workspace are not granted.
const names = ['skills/agent-network/SKILL.md', 'skills/agent-network/references/coordinator.md',
  'docs/ARCHITECTURE.md', 'docs/RELEASING.md'];
// The guide revision uses the original manifest entries; their references are separately covered by the archive hash.
const references = ['coordinator-persona.md', 'personal-assistant.md', 'managed-hosts.md'];
export const guideFiles = [...names, ...references.map(name => 'skills/agent-network/references/' + name)]
  .map(name => resolve(ROOT, name));
export async function networkGuide() {
  const hash = createHash('sha256');
  for (let i = 0; i < names.length; i++) hash.update(names[i] + '\0').update(await readFile(guideFiles[i])).update('\0');
  return { name: 'agent-network', entrypoint: guideFiles[0], revision: hash.digest('hex').slice(0, 12), files: guideFiles };
}
