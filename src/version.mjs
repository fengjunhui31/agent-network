import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './paths.mjs';

export const networkVersion = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
let manifest;
try { manifest = JSON.parse(readFileSync(resolve(ROOT, 'release-manifest.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (manifest && manifest.version !== networkVersion) throw new Error('Release manifest and package version differ');
export const buildId = manifest?.buildId ?? null;
