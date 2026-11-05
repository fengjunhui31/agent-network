import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './paths.mjs';

// runtime-versions.json is the single list of runtimes this build can drive.
// Member settings validate against it so a new runtime cannot be accepted in
// one code path and silently rejected in another.
export const SUPPORTED_RUNTIMES = Object.freeze(Object.keys(JSON.parse(readFileSync(resolve(ROOT, 'runtime-versions.json'), 'utf8'))));

export function assertRuntime(name) {
  if (!SUPPORTED_RUNTIMES.includes(name)) throw new Error('Unknown runtime');
  return name;
}
