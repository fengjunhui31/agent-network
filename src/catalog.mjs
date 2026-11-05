import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { INSTANCE_ROOT, readJson, writeJson, safeId } from './paths.mjs';

export class Catalog {
  constructor(config, root = INSTANCE_ROOT) {
    this.config = config; this.root = root; this.instances = new Map(); this.pendingSave = Promise.resolve(); this.preparations = new Map();
  }
  static async load(root = INSTANCE_ROOT) {
    const catalog = new Catalog(await readJson(resolve(root, 'network.json')), root);
    const saved = await readJson(resolve(root, '.local', 'agents.json'), {});
    for (const [id, value] of Object.entries(saved)) catalog.instances.set(id, value);
    for (const [id, value] of Object.entries(catalog.config.agents)) {
      if (!catalog.instances.has(id)) await catalog.create(value.template, id, true);
      else {
        const old = catalog.instances.get(id);
        const spec = catalog.spec(value.template, value);
        const workspace = resolve(root, spec.workspace ?? old.workspace);
        if (workspace !== old.workspace) throw new Error(`Changing ${id}'s workspace requires a new member ID to keep session history aligned`);
        catalog.instances.set(id, { ...old, ...spec, id, workspace, configDirectory: old.configDirectory, persistent: true });
      }
    }
    return catalog;
  }
  list() {
    return { agents: [...this.instances.values()], templates: this.config.templates };
  }
  get(id) { return this.instances.get(id); }
  coordinatorId(channelId) {
    const managers = Object.keys(this.config.agents).filter(id => this.get(id)?.manager);
    const preferred = channelId ?? this.config.coordinatorId;
    if (managers.includes(preferred)) return preferred;
    // Preserve the conventional ID on older instances that omitted coordinatorId.
    return managers.includes('assistant') ? 'assistant' : managers[0] ?? null;
  }
  async refresh() {
    const config = await readJson(resolve(this.root, 'network.json'));
    this.config = config;
    for (const [id, settings] of Object.entries(config.agents)) if (!this.instances.has(id)) await this.create(settings.template, id, true);
    for (const [id, old] of this.instances) {
      if (!old.persistent) continue;
      const overrides = config.agents[id] ?? old.overrides ?? { scope: old.scope };
      const spec = this.spec(overrides.template ?? old.template, overrides);
      this.instances.set(id, { ...old, ...spec, workspace: old.workspace, configDirectory: old.configDirectory });
    }
  }
  async save() {
    this.pendingSave = this.pendingSave.catch(() => {}).then(() =>
      writeJson(resolve(this.root, '.local', 'agents.json'), Object.fromEntries(this.instances)));
    await this.pendingSave;
  }
  async update(id, patch) {
    const old = this.get(id);
    if (!old) throw new Error('Unknown employee');
    if (patch.model && this.config.models && !this.config.models[patch.model]) throw new Error('Unknown model');
    if (patch.runtime && !['claude', 'dsh'].includes(patch.runtime)) throw new Error('Unknown runtime');
    const overrides = { ...old.overrides, ...patch };
    const updated = { ...old, ...patch, overrides };
    this.instances.set(id, updated);
    if (this.config.agents[id]) {
      this.config.agents[id] = { ...this.config.agents[id], ...patch };
      await writeJson(resolve(this.root, 'network.json'), this.config);
    }
    await this.save(); return updated;
  }
  spec(template, overrides = {}) {
    if (!this.config.templates[template]) throw new Error(`Unknown template: ${template}`);
    return { ...this.config.defaults, ...this.config.templates[template], ...overrides, template };
  }
  async create(template, requestedId, persistent = false, overrides = {}) {
    const spec = this.spec(template, { ...(persistent ? this.config.agents[requestedId] : {}), ...overrides });
    const id = safeId(requestedId ?? `${template}-${crypto.randomUUID().slice(0, 8)}`);
    if (this.instances.has(id)) throw new Error(`Agent already exists: ${id}`);
    const workspace = spec.workspace ? resolve(this.root, spec.workspace) : resolve(this.root, this.config.workspaceRoot, id);
    const configDirectory = resolve(this.root, '.local', 'agents', id);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    if (spec.model && this.config.models && !this.config.models[spec.model]) throw new Error('Unknown model');
    const agent = { ...spec, id, template, persistent, overrides, workspace, configDirectory, createdAt: new Date().toISOString() };
    this.instances.set(id, agent);
    // Concurrent template creation must not let an older snapshot overwrite a newer directory.
    await this.save();
    return agent;
  }
  prepare(agent) {
    const pending = (this.preparations.get(agent.id) ?? Promise.resolve()).catch(() => {}).then(() => this.prepareFiles(agent));
    this.preparations.set(agent.id, pending);
    return pending;
  }
  async prepareFiles(agent) {
    const team = await (await import('./team-context.mjs')).writeTeamContext(this, agent);
    const text = [
      `# ${agent.name ?? agent.id}`, agent.instructions, agent.extraInstructions,
      `工作目录：${agent.workspace}`, `能力：${agent.capabilities.join('、')}`,
      team,
      agent.manager
        ? `使用自己的工作目录与收到的共享输入。已绑定负责人要求维护本实例 ${this.root} 时，按网络规范准备候选版本。`
        : '使用自己的工作目录、收到的共享输入和本轮列出的只读网络说明。',
    ].join('\n\n');
    await writeFile(resolve(agent.workspace, 'AGENTS.md'), text);
    await writeFile(resolve(agent.workspace, 'CLAUDE.md'), text);
    return text;
  }
}
