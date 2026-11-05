import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ROOT, INSTANCE_ROOT, readJson, writeJson, safeId } from './paths.mjs';
import { assertRuntime } from './runtimes.mjs';
import { readPersona, updatePersona, personaInstructions } from './coordinator-persona.mjs';

export class Catalog {
  constructor(config, root = INSTANCE_ROOT) {
    this.config = config; this.root = root; this.instances = new Map(); this.pendingSave = Promise.resolve(); this.pendingUpdate = Promise.resolve(); this.preparations = new Map();
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
    await catalog.reloadPersona();
    return catalog;
  }
  list() {
    return { agents: [...this.instances.keys()].map(id => this.get(id)), templates: this.config.templates };
  }
  get(id) {
    const agent = this.instances.get(id);
    if (!agent || this.primaryPersona?.id !== id) return agent;
    const { name, role } = this.primaryPersona.profile;
    const overrides = { ...agent.overrides };
    if (Object.hasOwn(overrides, 'name')) overrides.name = name;
    if (Object.hasOwn(overrides, 'instructions')) overrides.instructions = role;
    return { ...agent, name, instructions: role, overrides };
  }
  async reloadPersona() {
    const id = this.coordinatorId(this.channel?.coordinatorId);
    const profile = id ? await readPersona(this.root, id) : null;
    this.primaryPersona = profile ? { id, profile } : null;
  }
  updateCoordinatorPersona(id, fields) {
    this.pendingUpdate = this.pendingUpdate.catch(() => {}).then(async () => {
      await this.refresh();
      if (id !== this.coordinatorId(this.channel?.coordinatorId)) throw new Error('Choose the primary coordinator');
      const profile = await updatePersona(this.root, id, fields);
      this.primaryPersona = { id, profile };
      await this.save();
      return profile;
    });
    return this.pendingUpdate;
  }
  coordinatorId(channelId) {
    const managers = Object.keys(this.config.agents).filter(id => this.instances.get(id)?.manager);
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
    await this.reloadPersona();
  }
  async save() {
    this.pendingSave = this.pendingSave.catch(() => {}).then(() =>
      writeJson(resolve(this.root, '.local', 'agents.json'), Object.fromEntries([...this.instances.keys()].map(id => [id, this.get(id)]))));
    await this.pendingSave;
  }
  update(id, patch, newModel) {
    this.pendingUpdate = this.pendingUpdate.catch(() => {}).then(async () => {
      await this.refresh();
      const old = this.get(id);
      if (!old) throw new Error('Unknown employee');
      if (this.primaryPersona?.id === id && (Object.hasOwn(patch, 'name') || Object.hasOwn(patch, 'instructions')))
        throw new Error('Use coordinator persona settings to change this identity');
      if (patch.runtime) assertRuntime(patch.runtime);
      if (patch.model && this.config.models && !Object.hasOwn(this.config.models, patch.model) && !newModel)
        throw new Error('Unknown model');
      const overrides = { ...old.overrides, ...patch };
      const updated = { ...old, ...patch, overrides };
      if (this.config.agents[id]) {
        const next = { ...this.config, agents: { ...this.config.agents, [id]: { ...this.config.agents[id], ...patch } } };
        if (newModel) next.models = { ...this.config.models, [patch.model]: newModel };
        await writeJson(resolve(this.root, 'network.json'), next);
        this.config = next;
      }
      this.instances.set(id, updated);
      await this.save();
      return updated;
    });
    return this.pendingUpdate;
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
    const primary = agent.id === this.coordinatorId(this.channel?.coordinatorId);
    if (primary) {
      await this.reloadPersona();
      agent = this.get(agent.id);
    }
    const identity = primary && this.primaryPersona ? personaInstructions(this.primaryPersona.profile) : agent.instructions;
    const owned = agent.workspace === resolve(this.root, this.config.workspaceRoot, agent.id);
    const directory = owned ? agent.workspace : agent.configDirectory;
    const team = await (await import('./team-context.mjs')).writeTeamContext(this, agent, directory);
    const profile = agent.workProfile === undefined && primary ? 'personal-assistant' : agent.workProfile;
    const workStyle = profile === 'personal-assistant'
      ? await readFile(resolve(ROOT, 'skills/agent-network/references/personal-assistant.md'), 'utf8') : '';
    const text = [
      `# ${agent.name ?? agent.id}`, identity, agent.extraInstructions, workStyle,
      `工作目录：${agent.workspace}`, `能力：${agent.capabilities.join('、')}`,
      team,
      agent.manager
        ? `使用自己的工作目录与收到的共享输入。已绑定负责人要求维护本实例 ${this.root} 时，按网络规范准备候选版本。`
        : '使用自己的工作目录、收到的共享输入和本轮列出的只读网络说明。',
    ].join('\n\n');
    await writeFile(resolve(directory, 'AGENTS.md'), text);
    await writeFile(resolve(directory, 'CLAUDE.md'), text);
    return text;
  }
}
