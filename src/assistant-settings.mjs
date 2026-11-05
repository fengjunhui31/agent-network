import { access, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { codexModels } from './codex-discovery.mjs';
import { runtimeInstallation } from './runtime-config.mjs';
import { assertRuntime, SUPPORTED_RUNTIMES } from './runtimes.mjs';

function declaredModels(catalog, runtime) {
  return Object.entries(catalog.config.models ?? {})
    .filter(([, spec]) => !spec.runtimes || spec.runtimes.includes(runtime))
    .map(([name]) => name);
}

export async function assistantSettings(network, { from, fromSessionKey, operation, runtime, model }) {
  const run = network.activeRun(from, fromSessionKey);
  if (!run || from !== network.members.coordinator() || network.peerSession(run))
    throw new Error('Assistant settings require an active local coordinator');
  const agent = network.catalog.get(from);
  const running = { runtime: run.runtime, model: run.model ?? null };
  const configured = () => {
    const a = network.catalog.get(from);
    return { runtime: a.runtime, model: a.model, employee: a.id, workspace: a.workspace };
  };
  if (operation === 'status') return { running, configured: configured(), runtimes: SUPPORTED_RUNTIMES };

  const target = runtime ?? agent.runtime;
  assertRuntime(target);
  if (operation === 'models') {
    const models = target === 'codex' ? await codexModels(agent.workspace) : declaredModels(network.catalog, target);
    return { runtime: target, models };
  }
  if (operation !== 'set') throw new Error('Select status, models or set');
  if (!(network.gate.channel?.ownsRun(run) || (!run.parentRunId && run.from === 'user')))
    throw new Error('A settings change requires a request from the bound owner');
  if (!model) throw new Error('Specify the model for the next run');
  if (target === agent.runtime && model === agent.model) return { running, configured: configured(), changed: false };
  const slot = await runtimeInstallation(target, network.root);
  await access(resolve(slot.directory, 'node_modules/.bin', slot.bin), constants.X_OK).catch(() => {
    throw new Error('Install the selected runtime on this instance first');
  });
  const declared = Object.hasOwn(network.catalog.config.models ?? {}, model) ? network.catalog.config.models[model] : undefined;
  if (declared?.runtimes && !declared.runtimes.includes(target)) throw new Error('Model is disabled for this runtime');
  if (target === 'codex') {
    if (!(await codexModels(agent.workspace)).includes(model)) throw new Error('This Codex runtime does not list the selected model');
  } else if (!declared) throw new Error('Select a model configured for this runtime');

  // A newly chosen Codex model is persisted together with the employee update, after native discovery.
  const newModel = declared ? undefined : { name: model, runtimes: [target] };
  await network.catalog.update(from, { runtime: target, model }, newModel);
  return { running, configured: configured(), changed: true, appliesTo: 'next-run' };
}
