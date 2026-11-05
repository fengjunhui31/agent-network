import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, access, rm } from 'node:fs/promises';
import { ROOT, LOCAL, readJson, writeJson } from '../src/paths.mjs';

function command(program, args, cwd, capture = false, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = ''; let error = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${program} failed (${code}): ${error.slice(-1000)}`)));
  });
}
const [action = 'status', name] = process.argv.slice(2);
const specs = await readJson(resolve(ROOT, 'runtime-versions.json'));
const stateFile = resolve(LOCAL, 'runtime-state.json');
const state = await readJson(stateFile, {});
if (name && !specs[name]) throw new Error(`Unknown runtime: ${name}`);
const names = name ? [name] : Object.keys(specs);

if (action === 'status' || action === 'check') {
  for (const id of names) {
    const spec = state[id]?.spec ?? specs[id];
    const result = { runtime: id, slot: state[id]?.active ?? 'initial', packages: spec.packages };
    if (action === 'check') {
      result.available = {};
      for (const pkg of Object.keys(spec.packages)) result.available[pkg] = JSON.parse(await command('npm', ['view', pkg, 'dist-tags', '--json'], ROOT, true));
    }
    console.log(JSON.stringify(result, null, 2));
  }
} else if (action === 'install' || action === 'update') {
  for (const id of names) {
    const spec = structuredClone(specs[id]);
    if (action === 'update') {
      for (const pkg of Object.keys(spec.packages)) {
        if (id === 'dsh' && pkg !== '@deepseek-ai/dsh') continue;
        spec.packages[pkg] = await command('npm', ['view', `${pkg}@latest`, 'version'], ROOT, true);
      }
      // DSH plugins must use the harness version, not their sometimes stale latest tag.
      if (id === 'dsh') spec.packages['@deepseek-ai/dsh-hooks-claude-code'] = spec.packages['@deepseek-ai/dsh'];
    }
    const slot = `${Date.now()}`;
    const directory = resolve(LOCAL, 'runtimes', id, slot);
    await mkdir(directory, { recursive: true });
    await writeJson(resolve(directory, 'package.json'), { private: true, dependencies: spec.packages });
    await command('npm', ['install', '--no-audit', '--no-fund'], directory);
    await access(resolve(directory, 'node_modules', '.bin', spec.bin));
    const executable = resolve(directory, 'node_modules', '.bin', id === 'claude' ? 'claude' : 'dsh');
    const version = await command(executable, ['--version'], directory, true);
    const previous = state[id] ?? { active: 'initial', spec: specs[id] };
    const candidate = { active: slot, spec, previous, installedAt: new Date().toISOString(), binaryVersion: version };
    const candidateFile = resolve(LOCAL, `runtime-state.candidate-${slot}.json`);
    await writeJson(candidateFile, { ...state, [id]: candidate });
    try {
      await command(process.execPath, [resolve(ROOT, 'scripts/verify-native.mjs'), '--runtime', id], ROOT, false,
        { ...process.env, LAN_RUNTIME_STATE_FILE: candidateFile });
    } finally { await rm(candidateFile, { force: true }); }
    // Failures leave the active installation untouched; the failed slot/report remains inspectable.
    state[id] = { ...candidate, nativeVerifiedAt: new Date().toISOString() };
    await writeJson(stateFile, state);
    console.log(`${id}: installed ${version}. Existing processes keep their version; restart the network then run npm run verify:live.`);
  }
} else if (action === 'rollback') {
  if (!name || !state[name]?.previous) throw new Error('Specify a runtime with a previous installation');
  const old = state[name];
  state[name] = { ...old.previous, previous: { active: old.active, spec: old.spec } };
  await writeJson(stateFile, state);
  console.log(`${name}: restored ${state[name].active}; restart the network.`);
} else throw new Error('Commands: status | check | install | update [claude|dsh] | rollback claude|dsh');
