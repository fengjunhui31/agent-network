#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const help = `${pkg.name} ${pkg.version}
  agent-network init INSTANCE
  agent-network activate|start|stop|status|rollback INSTANCE
  agent-network channel INSTANCE install NAME PACKAGE | disable | status | request GROUP_ID KEY MESSAGE_FILE
  agent-network agent|member|runtimes INSTANCE [...arguments]
  agent-network-release --help
  agent-network --version`;
async function createOnce(from, to) {
  try { await copyFile(from, to, constants.COPYFILE_EXCL); await chmod(to, 0o600); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}
function execute(command, args, instance) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, LAN_INSTANCE_ROOT: instance } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
try {
  const [action, location, ...args] = process.argv.slice(2);
  if (action === '--version' || action === '-v') console.log(pkg.version);
  else if (!action || action === '--help' || action === 'help') console.log(help);
  else {
    if (!location) throw new Error('Specify the instance directory. Use --help for commands.');
    const instance = resolve(location);
    if (action === 'init') {
      if (args.length) throw new Error('init takes one instance directory');
      await mkdir(join(instance, '.local'), { recursive: true, mode: 0o700 });
      await createOnce(join(root, 'examples/network.example.json'), join(instance, 'network.json'));
      for (const name of ['credentials.example.json'])
        await createOnce(join(root, 'examples', name), join(instance, '.local', name));
      console.log('Instance ready:', instance);
    } else if (action === 'channel') {
      execute(process.execPath,[join(root,'bootstrap/channel.mjs'),...args],instance);
    } else if (['activate','start','stop','status','rollback'].includes(action)) {
      if (args.length) throw new Error(action + ' takes one instance directory');
      execute(process.execPath, [join(root, 'bootstrap/release.mjs'), action, instance], instance);
    } else {
      const entries = { agent:'src/cli.mjs', member:'scripts/member.mjs', runtimes:'scripts/runtimes.mjs' };
      if (!Object.hasOwn(entries, action)) throw new Error('Unknown command. Use --help.');
      const script = join(instance, 'current', entries[action]);
      await access(script);
      if (!(await stat(script)).isFile()) throw new Error('Activate a release before running this command');
      execute(process.execPath, [script, ...args], instance);
    }
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
