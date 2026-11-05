// Exercise a packaged controller against a real earlier release in a disposable instance.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../src/paths.mjs';

const run = promisify(execFile);
const { values } = parseArgs({ options: { previous: { type: 'string' }, 'legacy-cli': { type: 'string' } } });
if (!values.previous) throw new Error('Pass --previous /path/to/previous.tar.gz and its .sha256 sidecar');
const previous = await realpath(resolve(values.previous));
const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
const temp = await realpath(await mkdtemp(join(tmpdir(), 'network-release-acceptance-')));
const instance = join(temp, 'instance'),
  local = join(instance, '.local');
const nodeModules = join(temp, 'node_modules'),
  installer = join(nodeModules, '.bin/agent-network'),
  cli = join(nodeModules, '.bin/agent-network-release');
const checks = [];
async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
async function until(fn) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(80);
  }
  throw new Error('Timed out waiting for the isolated release operation');
}
const shim = join(temp, 'no-python'),
  pythonCalled = join(shim, 'invoked');
const env = { ...process.env, PATH: shim + ':' + process.env.PATH };
const call = (...args) => run(cli, args, { env, timeout: 180000 });
const status = async () => JSON.parse((await call('status', instance)).stdout);
async function gate() {
  const endpoint = await json(join(local, 'release-control.json'));
  const res = await fetch(endpoint.url + '/maintenance', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + endpoint.token },
    body: '{"action":"status"}'
  });
  assert.equal(res.status, 200);
  return res.json();
}
async function recover() {
  // Pipe EOF releases the operating system lock when the simulated supervisor is killed.
  await until(async () => {
    try {
      await call('recover', instance);
      return true;
    } catch (error) {
      if (error.stderr?.includes('Another release operation')) return false;
      throw error;
    }
  });
}
let initialized = false;
try {
  await run('npm', [
    'install',
    '--offline',
    '--prefix',
    temp,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    join(ROOT, 'dist', 'shiyanjia-agent-network-' + version + '.tgz')
  ]);
  await mkdir(shim);
  for (const name of ['python', 'python3']) {
    const file = join(shim, name);
    await writeFile(file, '#!/bin/sh\ntouch "' + pythonCalled + '"\nexit 99\n');
    await chmod(file, 0o755);
  }
  await run(installer, ['init', instance], { env });
  if (values['legacy-cli'])
    await run(resolve(values['legacy-cli']), ['activate', instance], { timeout: 180000 });
  else await call('activate', instance, '--archive', previous);
  initialized = true;
  const old = (await status()).current.version;
  assert.notEqual(old, version);
  assert.equal(basename(previous), 'agent-network-' + old + '.tar.gz');
  const workspace = join(
    local,
    'workspaces',
    Object.keys((await json(join(instance, 'network.json'))).agents)[0]
  );
  const marker = join(workspace, 'project-note.txt');
  await writeFile(marker, 'keep this customer work\n');
  const agentState = await readFile(join(local, 'agents.json'));
  const networkId = (await json(join(local, 'join.json'))).networkId;
  await call('activate', instance);
  assert.equal((await status()).previous.version, old);
  await call('rollback', instance);
  assert.equal((await status()).current.version, old);
  checks.push('previous release -> packaged Node release -> previous release');
  const slot = randomUUID(),
    id = 'fixture';
  const mod = join(local, 'channels', slot, 'node_modules/@shiyanjia/agent-network-fixture');
  await mkdir(mod, { recursive: true });
  await writeFile(
    join(mod, 'package.json'),
    JSON.stringify({
      name: '@shiyanjia/agent-network-fixture',
      version: '1.0.0',
      main: 'index.mjs',
      agentNetworkChannel: { id, apiVersion: 1 }
    })
  );
  const fault = join(local, 'fixture-fault');
  await writeFile(
    join(mod, 'index.mjs'),
    [
      "import {readFile} from 'node:fs/promises';",
      "import {join} from 'node:path';",
      'export async function startChannel(network) {',
      " const current=JSON.parse(await readFile(join(process.cwd(),'package.json'))).version;",
      " const fault=await readFile(join(network.root,'.local/fixture-fault'),'utf8').catch(()=>null);",
      ' if(current===' +
        JSON.stringify(version) +
        " && fault==='fail') throw new Error('fixture startup failure');",
      ' if(current===' +
        JSON.stringify(version) +
        " && fault==='delay') await new Promise(done=>setTimeout(done,55000));",
      " const readyAt=new Date().toISOString();return {id:'fixture',activity(){return {id:this.id,ready:true,initialized:true,readyAt}},ownsRun(){return false},resume(){},close(){}};",
      '}'
    ].join('\n')
  );
  await writeFile(join(local, 'channel.json'), JSON.stringify({ enabled: true, id, slot, version: '1.0.0' }));
  await writeFile(fault, 'fail');
  await assert.rejects(call('activate', instance), /Candidate exited/);
  assert.equal((await status()).current.version, old);
  assert.equal((await gate()).phase, 'open');
  checks.push('candidate startup failure restores an open previous service');
  await writeFile(fault, 'delay');
  const child = spawn(cli, ['activate', instance], { env, stdio: 'ignore' });
  const exit = new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', done);
  });
  const interrupted = await until(async () => {
    try {
      const pending = await json(join(local, 'release-pending.json'));
      const record = await json(join(local, 'upgrades', pending.operationId, 'upgrade-record.json'));
      return record.phase === 'starting' && record.startingPid && record;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  });
  await assert.rejects(call('rollback', instance), /Another release operation/);
  child.kill('SIGKILL');
  await exit;
  await recover();
  const recovered = await json(join(local, 'upgrades', interrupted.operationId, 'upgrade-record.json'));
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.recovery, 'previous-application-restored');
  assert.equal((await status()).current.version, old);
  assert.equal((await gate()).phase, 'open');
  checks.push('concurrent operation excluded, interrupted pre-commit switch recovered');
  await rm(fault);
  const controller = pathToFileURL(
    join(nodeModules, '@shiyanjia/agent-network/bootstrap/release-controller.mjs')
  ).href;
  const archive = join(
    nodeModules,
    '@shiyanjia/agent-network/release',
    'agent-network-' + version + '.tar.gz'
  );
  const simulate =
    'import {ReleaseController} from ' +
    JSON.stringify(controller) +
    "; ReleaseController.prototype.settle=()=>process.exit(79); await new ReleaseController(process.argv[1],15).operate('activate',process.argv[2],null,'commit-crash');";
  await assert.rejects(
    run(process.execPath, ['--input-type=module', '-e', simulate, instance, archive], {
      env,
      timeout: 45000
    }),
    (error) => error.code === 79
  );
  const committed = await status();
  assert.equal(committed.current.version, version);
  assert.equal((await gate()).phase, 'holding');
  const pid = (await json(join(local, 'server.json'))).pid;
  await recover();
  assert.equal((await json(join(local, 'server.json'))).pid, pid);
  assert.equal((await gate()).phase, 'open');
  checks.push('committed switch recovered in place');
  await call('rollback', instance);
  const scheduled = (await call('schedule', instance)).stdout.match(/Scheduled (\S+)/)?.[1];
  assert.ok(scheduled);
  const record = await until(async () => {
    const operation = await json(join(local, 'upgrades', scheduled, 'upgrade-record.json'));
    if (operation.status === 'failed') throw new Error(operation.error);
    return operation.status === 'succeeded' && operation;
  });
  assert.equal(record.phase, 'complete');
  assert.equal((await status()).current.version, version);
  assert.equal(await readFile(marker, 'utf8'), 'keep this customer work\n');
  assert.deepEqual(await readFile(join(local, 'agents.json')), agentState);
  assert.equal((await json(join(local, 'join.json'))).networkId, networkId);
  await assert.rejects(access(pythonCalled), { code: 'ENOENT' });
  checks.push(
    'detached schedule, preserved identity and workspace, zero Python invocations by new controller'
  );
  console.log(JSON.stringify({ previous: old, version, checks, passed: true }));
} finally {
  if (initialized) await call('stop', instance);
  await rm(temp, { recursive: true, force: true });
}
