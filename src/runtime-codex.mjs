import { access, mkdir, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// A private CODEX_HOME keeps this member's model, project trust and hook trust
// out of the user's own Codex client, which shares only the ChatGPT login.
export async function codexHome(agent, model) {
  const home = resolve(agent.configDirectory, 'codex');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const userAuth = resolve(process.env.HOME ?? '', '.codex', 'auth.json');
  await access(userAuth).catch(() => {
    throw new Error('Codex runs on the local ChatGPT login; run `codex login` once before adding a codex member');
  });
  const auth = resolve(home, 'auth.json');
  await access(auth).catch(() => symlink(userAuth, auth));
  await writeFile(resolve(home, 'config.toml'), [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "openai"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[features]',
    'hooks = true',
    '',
    `[projects.${JSON.stringify(agent.workspace)}]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'));
  return home;
}

// Codex accepts session-scoped hooks through CODEX_CONFIG, but runs none of
// them until each one is trusted by hash. The hash is Codex's own digest, so
// ask the runtime instead of recomputing it here; a mismatch silently disables
// injection while leaving the member looking healthy.
export async function trustCodexHooks(rpc, cwd) {
  const listed = await rpc.request('_codex/hooks/list', { cwd }, { signal: AbortSignal.timeout(20000) });
  const hooks = (listed?.hooks ?? []).map(({ key, currentHash }) => ({ key, currentHash }));
  if (!hooks.length) throw new Error('Codex did not load the network hooks for this member');
  const result = await rpc.request('_codex/hooks/trust', { cwd, hooks }, { signal: AbortSignal.timeout(20000) });
  if (!result?.trusted) throw new Error('Codex refused to trust the network hooks; message injection would not work');
}
