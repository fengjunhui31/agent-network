// The npm bootstrap has only Node built-ins. Enrollment credentials are consumed by the activated core.
import { readFile, stat, mkdir, writeFile, rename, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export async function prepareHost(instance, args, initialize, releaseCli) {
  if (process.env.LAN_AGENT_ID) throw new Error('Machine enrollment is a local owner operation');
  const option = args.indexOf('--invite');
  if (!args.includes('--consent') || option < 0 || !args[option + 1])
    throw new Error('Use join --invite PRIVATE_FILE --consent');
  const file = resolve(args[option + 1]),
    st = await stat(file);
  if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.size > 16000)
    throw new Error('Use an owner-only invitation file (chmod 600)');
  const inv = JSON.parse(await readFile(file, 'utf8')),
    relay = inv.relay;
  if (
    inv.kind !== 'owned-host' ||
    inv.version !== 1 ||
    typeof inv.secret !== 'string' ||
    !Number.isSafeInteger(inv.expires) ||
    inv.expires <= Date.now() ||
    !/^\/(?:ip4|ip6|dns|dns4|dns6)\/[^/]+\/tcp\/[1-9]\d*$/.test(relay?.address) ||
    !/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/.test(relay.peerId)
  )
    throw new Error('Invalid or expired machine invitation');
  await initialize(instance);
  const { withReleaseLock } = await import(pathToFileURL(join(dirname(releaseCli), 'release-lock.mjs')).href);
  return withReleaseLock(
    instance,
    async () => {
      const config = join(instance, 'network.json'),
        before = await readFile(config),
        net = JSON.parse(before);
      if (
        net.federation?.enabled &&
        (net.federation.relay?.peerId !== relay.peerId || net.federation.relay?.address !== relay.address)
      )
        throw new Error('This instance is pinned to another relay; select a separate instance');
      const exists = await access(join(instance, 'current', 'scripts/host.mjs')).then(
        () => true,
        () => false
      );
      const changed = !net.federation?.enabled;
      const temp = config + '.' + randomUUID() + '.tmp';
      let staged;
      try {
        if (changed) {
          net.federation = {
            ...net.federation,
            enabled: true,
            routing: 'local-first',
            relay: { address: relay.address, peerId: relay.peerId }
          };
          staged = Buffer.from(JSON.stringify(net, null, 2) + '\n');
          await writeFile(temp, staged, { flag: 'wx', mode: 0o600 });
          await rename(temp, config);
        }
        if (!exists || changed)
          execFileSync(process.execPath, [releaseCli, !exists ? 'activate' : 'restart', instance], {
            stdio: ['ignore', 'ignore', 'inherit'],
            timeout: 1200000
          });
        else
          execFileSync(process.execPath, [releaseCli, 'start', instance], {
            stdio: ['ignore', 'ignore', 'inherit'],
            timeout: 1200000
          });
      } catch (error) {
        if (staged && staged.equals(await readFile(config))) {
          await writeFile(temp, before, { mode: 0o600 });
          await rename(temp, config);
        }
        throw error;
      } finally {
        await rm(temp, { force: true });
      }
    },
    'host-enrollment.lock'
  );
}
