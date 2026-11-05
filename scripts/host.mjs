import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { readFile, stat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { INSTANCE_ROOT, readJson } from '../src/paths.mjs';
import { inspectHost, localPolicy } from '../src/host-inventory.mjs';
import { HostStore } from '../src/host-store.mjs';
import { identity } from '../src/federation-identity.mjs';
import { inviteSpec } from '../src/host-enroll.mjs';
const {
  positionals: [command = 'help'],
  values: o
} = parseArgs({
  allowPositionals: true,
  options: {
    alias: { type: 'string' },
    id: { type: 'string' },
    out: { type: 'string' },
    invite: { type: 'string' },
    consent: { type: 'boolean' },
    wait: { type: 'string' },
    capability: { type: 'string' },
    project: { type: 'string', multiple: true },
    'all-cli': { type: 'boolean' },
    policy: { type: 'string' },
    operation: { type: 'string' },
    resource: { type: 'string' }
  }
});
const root = INSTANCE_ROOT,
  manager = Boolean(process.env.LAN_AGENT_ID);
async function call(action, fields = {}) {
  const ep = manager
    ? { url: process.env.LAN_URL, token: process.env.LAN_TOKEN }
    : await readJson(join(root, '.local/release-control.json'));
  if (new URL(ep.url).hostname !== '127.0.0.1') throw new Error('Expected local instance endpoint');
  const res = await fetch(ep.url + (manager ? '/hosts/manager' : '/hosts/owner'), {
    method: 'POST',
    headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      action,
      ...fields,
      ...(manager
        ? { from: process.env.LAN_AGENT_ID, fromSessionKey: process.env.LAN_SESSION_KEY || undefined }
        : {})
    }),
    signal: AbortSignal.timeout(140000)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error);
  return result;
}
async function policy() {
  const p = o.policy ? await readJson(resolve(o.policy)) : {};
  if (o['all-cli']) p.enumeratePath = true;
  for (const pair of o.project ?? []) {
    const i = pair.indexOf('=');
    if (i < 1) throw new Error('Use --project public-label=local-directory');
    (p.projects ??= {})[pair.slice(0, i)] = await realpath(resolve(pair.slice(i + 1)));
  }
  return localPolicy.parse(p);
}
async function main() {
  if (command === 'help')
    return 'host INSTANCE inspect | identity | invite --alias NAME --out PRIVATE_FILE | join --invite PRIVATE_FILE --consent [--project label=DIR] [--all-cli] | pending | approve/revoke --id INVITATION_ID | list [--capability NAME] | detail/refresh --alias NAME | invoke --alias NAME --operation ACTION --resource LABEL | policy --policy LOCAL_FILE | sync | leave | status';
  if (manager && !['list', 'detail', 'pending', 'approve', 'revoke', 'refresh', 'invoke'].includes(command))
    throw new Error('Use the local owner CLI');
  switch (command) {
    case 'inspect': {
      const s = (await new HostStore(root).read()).local;
      return inspectHost(
        root,
        s.contextId,
        o.policy || o.project || o['all-cli'] ? await policy() : s.policy
      );
    }
    case 'identity': {
      const ctx = await readJson(join(root, '.local/join.json'), {});
      return (await identity(join(root, '.local/federation/identity.json'), ctx.networkId)).card;
    }
    case 'invite': {
      if (!o.out) throw new Error('Specify a private output file using --out');
      const file = resolve(o.out);
      if (!file.endsWith('.host-invite.json'))
        throw new Error('Use the .host-invite.json suffix for private invitations');
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const dest = await open(file, 'wx', 0o600);
      try {
        const inv = await call('invite', { alias: o.alias });
        await dest.writeFile(JSON.stringify(inv) + '\n');
        await dest.sync();
        return { id: inv.id, alias: inv.alias, expires: inv.expires, file };
      } catch (e) {
        await import('node:fs/promises').then((fs) => fs.rm(file, { force: true }));
        throw e;
      } finally {
        await dest.close();
      }
    }
    case 'join': {
      if (!o.invite || !o.consent) throw new Error('Use join --invite PRIVATE_FILE --consent');
      const file = resolve(o.invite);
      const st = await stat(file);
      if (st.uid !== process.getuid() || st.mode & 0o077 || st.size > 16000)
        throw new Error('Use a private, owner-only invitation file');
      const invitation = inviteSpec.parse(JSON.parse(await readFile(file, 'utf8')));
      const wait = Number(o.wait ?? 0);
      if (!Number.isSafeInteger(wait) || wait < 0 || wait > 86400)
        throw new Error('Use --wait SECONDS (0–86400)');
      let result = await call('join', { invitation, consent: true, policy: await policy() });
      const end = Date.now() + 1000 * wait;
      while (Date.now() < end && result.registration?.state === 'pending') {
        await delay(500);
        result = await call('status');
      }
      return result;
    }
    case 'policy':
      if (!o.policy) throw new Error('Specify --policy LOCAL_JSON');
      return call('policy', { policy: await policy() });
    case 'list':
      return call('list', { search: o.capability });
    case 'detail':
      return call('detail', { alias: o.alias });
    case 'refresh':
    case 'invoke':
      return call('invoke', {
        alias: o.alias,
        operation: command === 'refresh' ? 'inventory.refresh' : o.operation,
        resource: o.resource
      });
    case 'approve':
    case 'revoke':
      return call(command, { id: o.id });
    case 'pending':
    case 'status':
    case 'sync':
    case 'leave':
      return call(command);
    default:
      throw new Error('Unknown host command');
  }
}
try {
  const result = await main();
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
