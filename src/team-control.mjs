import { teamStatus } from './team-context.mjs';

export async function teamControl(network, { action, template, id, patch = {}, from }) {
  await network.catalog.refresh();
  const caller = from ? network.catalog.get(from) : null;
  if (from && !caller?.manager) throw new Error('Only a team coordinator can manage employees');
  if (action === 'status') return teamStatus(network.catalog, caller?.scope, !caller || Boolean(caller.manager));
  const allowed = ['name', 'runtime', 'model', 'instructions', 'capabilities'];
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Unsupported employee setting');
  if (patch.runtime && !['claude', 'dsh'].includes(patch.runtime)) throw new Error('Unknown runtime');
  if (patch.model && !network.catalog.config.models?.[patch.model]) throw new Error('Unknown model');
  if (action === 'create') return network.catalog.create(template, id, true, { ...patch, ...(caller?.scope ? { scope: caller.scope } : {}) });
  if (action === 'update') {
    const employee = network.catalog.get(id); if (!employee) throw new Error('Unknown employee');
    network.assertScope(from, employee);
    const updated = await network.catalog.update(id, patch);
    return { ...updated, appliesOnNextRun: network.isBusy(id) };
  }
  throw new Error('Team actions: status | create | update');
}
