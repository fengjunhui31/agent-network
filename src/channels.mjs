// Channel API v1. The core only loads a package explicitly installed for this instance.
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './paths.mjs';

export async function startConfiguredChannel(network, requested) {
  const config = await readJson(resolve(network.root,'.local/channel.json'), null);
  if (!config?.enabled) {
    if (requested) throw new Error('Requested channel is not installed and enabled: '+requested);
    return null;
  }
  if (requested && requested !== config.id) throw new Error('Requested channel differs from the enabled channel');
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(config.id) || !/^[a-f0-9-]{36}$/.test(config.slot))
    throw new Error('Invalid instance channel configuration');
  const root = await realpath(resolve(network.root,'.local/channels',config.slot,'node_modules','@shiyanjia','agent-network-'+config.id));
  const manifest = JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  if (manifest.name!=='@shiyanjia/agent-network-'+config.id || manifest.version!==config.version ||
      manifest.agentNetworkChannel?.apiVersion!==1 || manifest.agentNetworkChannel.id!==config.id)
    throw new Error('Installed channel identity or host API differs');
  const entry = await realpath(resolve(root,manifest.main));
  if (!entry.startsWith(root+sep)) throw new Error('Channel entry escapes the installed package');
  const module = await import(pathToFileURL(entry).href);
  const channel = await module.startChannel(network);
  if (channel?.id!==config.id || !['activity','ownsRun','resume','close'].every(method=>typeof channel[method]==='function')) {
    await channel?.close?.(); throw new Error('Channel does not implement API v1');
  }
  network.gate.channel=channel; network.catalog.channel=channel;
  return channel;
}
