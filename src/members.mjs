import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from './paths.mjs';

const now = () => new Date().toISOString();
const label = limit => z.string().trim().min(1).max(limit).refine(s => !/[\u0000-\u001f\u007f]/.test(s), 'Use a single line of text');
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const path = label(2048).refine(s => isAbsolute(s) && resolve(s) === s && s !== sep, 'Select an absolute project directory');
const unique = names => new Set(names).size === names.length;
export const application = z.object({
  id, name: label(100), runtime: id, projects: z.array(path).min(1).max(32).refine(unique, 'Duplicate project'),
  consent: z.literal(true),
}).strict();
const session = z.object({ id: label(160), purpose: label(320).nullable(), source: z.enum(['title','declared','unknown']),
  archived: z.boolean().optional(), updatedAt: z.string().datetime().optional() }).strict()
  .refine(x => (x.source === 'unknown') === (x.purpose === null), 'An unknown purpose must be null');
const tool = z.object({ name: label(180), source: z.enum(['skill','mcp','project-script','declared']) }).strict();
export const projectReport = z.object({
  project: path, sessions: z.array(session).max(1000).refine(xs => unique(xs.map(x => x.id)), 'Duplicate session'),
  tools: z.array(tool).max(1200).refine(xs => unique(xs.map(x => x.source + '/' + x.name)), 'Duplicate tool'),
  purpose: label(320).optional(), partial: z.array(z.enum(['sessions-limited','sessions-unreported','skills-unavailable','mcp-unavailable','tools-limited','scripts-unavailable'])).max(6).default([]),
}).strict();
const storage = catalog => resolve(catalog.root, '.local/member-directory.json');
const empty = () => ({ schemaVersion: 1, entries: {} });
const hash = value => createHash('sha256').update(value).digest('hex');
const eligible = record => record?.status === 'approved';
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
function identity(record) {
  return { id: record.id, address: 'member:' + record.id, name: record.name, runtime: record.runtime,
    status: record.status, projects: record.projects, boundAgent: record.boundAgent ?? null, updatedAt: record.updatedAt };
}
function canBind(catalog, record, agentId) {
  const agent = catalog.get(agentId);
  return agent && Object.hasOwn(catalog.config.agents, agentId) && agent.runtime === record.runtime && !agent.manager && !agent.scope;
}
export async function memberSummary(catalog, scope, manager) {
  if (scope) return { externalMembers:[] };
  const state = await readJson(storage(catalog), empty());
  const records = Object.values(state.entries);
  const externalMembers = records.filter(eligible).map(e => ({
    address: 'member:' + e.id, name: e.name, runtime: e.runtime, reportedProjects: e.reports.length,
    executionAgent: canBind(catalog, e, e.boundAgent) ? e.boundAgent : null,
  }));
  return { externalMembers, ...(manager ? {pendingMemberships:records.filter(e => e.status === 'pending').length} : {}) };
}
export class MemberDirectory {
  constructor(catalog, channelCoordinator = () => undefined) { this.catalog = catalog; this.channelCoordinator = channelCoordinator; this.file = storage(catalog); this.writes = Promise.resolve(); }
  async read() { await this.writes; return readJson(this.file, empty()); }
  edit(fn) {
    const operation = this.writes.then(async () => {
      const state = await readJson(this.file, empty());
      const value = fn(state.entries);
      await writeJson(this.file, state); return value;
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  async self(secret, args) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('A private member credential is required');
    const memberId = id.parse(args.id);
    const fingerprint = hash(secret);
    const check = record => {
      if (!record || !timingSafeEqual(Buffer.from(record.keyHash), Buffer.from(fingerprint))) throw new Error('Unknown member or credential');
    };
    if (args.action === 'status') {
      const record = own((await this.read()).entries, memberId); check(record); return identity(record);
    }
    return this.edit(entries => {
      const previous = own(entries, memberId);
      if (previous) check(previous);
      if (args.action === 'join') {
        const form = application.parse(args.application);
        if (form.id !== memberId) throw new Error('Member ID mismatch');
        form.projects.sort();
        if (previous && ['pending','approved'].includes(previous.status)) {
          if (previous.name !== form.name || previous.runtime !== form.runtime || JSON.stringify(previous.projects) !== JSON.stringify(form.projects))
            throw new Error('Leave first to replace the agreed project scope');
          return identity(previous);
        }
        if (!previous && Object.keys(entries).length >= 512) throw new Error('Local directory is full');
        const record = { ...form, status: 'pending', keyHash: fingerprint, reports: [], boundAgent: null, updatedAt: now() };
        entries[memberId] = record;
        return identity(record);
      }
      check(previous);
      if (args.action === 'leave') {
        Object.assign(previous, { status: 'left', reports: [], projects: [], boundAgent: null, updatedAt: now() });
        return identity(previous);
      }
      if (args.action !== 'report' || !['pending','approved'].includes(previous.status)) throw new Error('Membership is not accepting reports');
      const report = projectReport.parse(args.report);
      if (!previous.projects.includes(report.project)) throw new Error('Project is outside this membership');
      previous.updatedAt = now();
      previous.reports = [...previous.reports.filter(p => p.project !== report.project), { ...report, reportedAt: previous.updatedAt }];
      return { id: memberId, status: previous.status, project: report.project, sessions: report.sessions.length, tools: report.tools.length };
    });
  }
  coordinator() { return this.catalog.coordinatorId(this.channelCoordinator()); }
  async manage({ action, id: memberId, agent, query = '', project }) {
    if (action === 'pending') return Object.values((await this.read()).entries).filter(e => e.status === 'pending').map(identity);
    if (action === 'query') {
      const input = z.string().trim().max(320).parse(query).toLowerCase();
      const matches = value => value?.toLowerCase().includes(input);
      const entries = Object.values((await this.read()).entries).filter(e => eligible(e) && (!memberId || e.id === memberId));
      return { coordinator: this.coordinator(),
        managed: this.catalog.list().agents.filter(a => !a.scope && a.persistent && this.catalog.config.agents[a.id]).map(a => ({ id: a.id, runtime: a.runtime, role: a.manager ? 'coordinator' : 'employee', capabilities: a.capabilities })),
        members: entries.flatMap(e => {
          const reports = e.reports.filter(p => !project || p.project === project).flatMap(p => {
            const whole = !input || [p.project,p.purpose,e.id,e.name,e.runtime].some(matches);
            if (!input) return [p];
            const sessionHits = p.sessions.filter(x => matches(x.id) || matches(x.purpose));
            const toolHits = p.tools.filter(x => matches(x.name));
            if (!whole && !sessionHits.length && !toolHits.length) return [];
            // Return the associated project context as well as matching names.
            const sessions = [...new Set([...sessionHits, ...p.sessions])].slice(0,8);
            const tools = [...new Set([...toolHits, ...p.tools])].slice(0,12);
            return [{ ...p, sessions, tools, sessionCount:p.sessions.length, toolCount:p.tools.length,
              more:sessions.length < p.sessions.length || tools.length < p.tools.length }];
          });
          const waiting = e.projects.filter(dir => !e.reports.some(p => p.project === dir) && (!project || project === dir)
            && (!input || [dir,e.id,e.name,e.runtime].some(matches)));
          if ((input || project) && !reports.length && !waiting.length) return [];
          const summary = identity(e);
          const rows = !memberId && !input && !project ? reports.map(p => ({ project:p.project,purpose:p.purpose,reportedAt:p.reportedAt,sessionCount:p.sessions.length,toolCount:p.tools.length,partial:p.partial })) : reports;
          return [{ ...summary, executionAgent: canBind(this.catalog, e, e.boundAgent) ? e.boundAgent : null, awaitingReports:waiting, reports:rows }];
        }) };
    }
    id.parse(memberId);
    return this.edit(entries => {
      const entry = own(entries, memberId);
      if (!entry) throw new Error('Unknown membership');
      if (action === 'approve') {
        if (entry.status !== 'pending' && entry.status !== 'approved') throw new Error('Member must submit a new application');
        if (agent !== undefined && !canBind(this.catalog, entry, agent)) throw new Error('Choose a managed employee of the same runtime');
        entry.status = 'approved';
        if (agent !== undefined) entry.boundAgent = agent;
      } else if (action === 'reject' || action === 'revoke') {
        const status = action === 'reject' ? 'rejected' : 'revoked';
        if (entry.status !== status && entry.status !== (action === 'reject' ? 'pending' : 'approved')) throw new Error('Membership state does not allow this action');
        Object.assign(entry, { status, reports: [], projects: [], boundAgent: null });
      } else throw new Error('Unknown membership decision');
      entry.updatedAt = now(); return identity(entry);
    });
  }
  async target(address) {
    if (typeof address !== 'string' || !address.startsWith('member:')) return address;
    const record = own((await this.read()).entries, address.slice(7));
    if (!eligible(record)) throw new Error('Member is not approved or has left the network');
    if (!canBind(this.catalog, record, record.boundAgent)) throw new Error('This member reports project information and has no execution binding');
    return record.boundAgent;
  }
}
