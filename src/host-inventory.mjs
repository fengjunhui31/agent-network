import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readJson } from './portable-io.mjs';
import { codexReport, projectScripts } from './codex-discovery.mjs';

const exec = promisify(execFile);
const label = z
  .string()
  .regex(/^[\p{L}\p{N}_.:@+-]{1,140}$/u)
  .refine((s) => !/(?:sk-|ghp_|gho_|npm_|Bearer)[\w-]{12,}/i.test(s));
export const resourceName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const localPolicy = z
  .object({
    projects: z.record(resourceName, z.string().max(4096).refine(isAbsolute)).default({}),
    extraCli: z
      .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,63}$/))
      .max(64)
      .default([]),
    enumeratePath: z.boolean().default(false),
    documents: z.record(resourceName, z.string().regex(/^[\w-]{5,160}$/)).default({})
  })
  .strict()
  .refine((p) => Object.keys(p.projects).length <= 8 && Object.keys(p.documents).length <= 32);
const version = z.string().max(60).nullable();
const method = z.enum(['inventory.refresh', 'cli.version', 'lark.document.read']);
export const snapshotSpec = z
  .object({
    version: z.literal(1),
    contextId: z.string().uuid(),
    os: z.enum([
      'darwin',
      'linux',
      'freebsd',
      'openbsd',
      'netbsd',
      'aix',
      'sunos',
      'win32',
      'android',
      'unknown'
    ]),
    observedAt: z.string().datetime(),
    runtimes: z
      .array(
        z
          .object({
            id: label,
            type: label,
            installationId: label,
            source: z.enum(['path', 'managed']),
            version,
            adapter: z.enum(['acp', 'index-only', 'unverified'])
          })
          .strict()
      )
      .max(64),
    cli: z.array(z.object({ name: label, version }).strict()).max(2048),
    capabilities: z
      .array(
        z
          .object({
            runtime: label,
            project: label.optional(),
            source: z.enum(['skill', 'mcp', 'project-script']),
            name: label,
            status: z.enum(['declared', 'reported'])
          })
          .strict()
      )
      .max(10000),
    grants: z.array(z.object({ action: method, resource: label.optional() }).strict()).max(128),
    partial: z.array(label).max(150)
  })
  .strict()
  .superRefine((s, ctx) => {
    const ids = new Set(s.runtimes.map((x) => x.id));
    if (ids.size !== s.runtimes.length || s.capabilities.some((c) => !ids.has(c.runtime)))
      ctx.addIssue({ code: 'custom', message: 'Inconsistent runtime reference' });
  });
const installationId = (context, file) =>
  createHash('sha256')
    .update(context + '\0' + file)
    .digest('hex')
    .slice(0, 24);
const runtimeTypes = ['claude', 'codex', 'dsh', 'kimi', 'zcode', 'mimo'];
const familiar = ['lark-cli', 'git', 'gh', 'node', 'npm', 'python3', 'ssh', 'docker', 'rg'];
const paths = () => [...new Set((process.env.PATH ?? '').split(delimiter).filter(isAbsolute))];
const publicName = (s) => label.safeParse(s).success;
export async function executable(file) {
  try {
    const actual = await realpath(file),
      s = await stat(actual);
    if (!s.isFile() || s.mode & 0o022 || ![0, process.getuid()].includes(s.uid)) return null;
    await access(actual, constants.X_OK);
    return actual;
  } catch {
    return null;
  }
}
export async function commandPath(name) {
  if (!publicName(name)) return null;
  for (const dir of paths()) {
    const p = await executable(join(dir, name));
    if (p) return p;
  }
  return null;
}
async function commandVersion(name, file) {
  if (!file || ![...runtimeTypes, ...familiar].includes(name)) return null;
  try {
    const { stdout, stderr } = await exec(file, ['--version'], {
      cwd: homedir(),
      timeout: 3500,
      maxBuffer: 12000,
      env: { HOME: homedir(), PATH: process.env.PATH ?? '', LANG: 'C', NO_COLOR: '1' }
    });
    return (
      (stdout + ' ' + stderr).match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0]?.slice(0, 60) ??
      null
    );
  } catch {
    return null;
  }
}
async function skillNames(dir) {
  const rows = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names = [];
  for (const row of rows.slice(0, 512)) {
    if (!publicName(row.name) || !(row.isDirectory() || row.isSymbolicLink())) continue;
    if (
      await stat(join(dir, row.name, 'SKILL.md')).then(
        (s) => s.isFile(),
        () => false
      )
    )
      names.push(row.name);
  }
  return names.sort();
}
export async function inspectHost(root, contextId, options = {}, probe = {}) {
  const policy = localPolicy.parse(options),
    lookup = probe.lookup ?? commandPath,
    versionOf = probe.version ?? commandVersion;
  const runtimes = [],
    cli = [],
    capabilities = new Map(),
    partial = new Set();
  const extra = new Set([...familiar, ...policy.extraCli]);
  if (policy.enumeratePath) {
    for (const dir of paths()) {
      const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of names) {
        if (!publicName(entry.name) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
        if (extra.size >= 2048) {
          partial.add('cli-limited');
          break;
        }
        extra.add(entry.name);
      }
    }
  }
  for (const name of [...extra].sort()) {
    const file = await lookup(name);
    if (file) cli.push({ name, version: await versionOf(name, file) });
  }
  const managed = await readJson(join(root, '.local/runtime-state.json'), {});
  for (const type of runtimeTypes) {
    const file = await lookup(type);
    if (file)
      runtimes.push({
        id: 'path.' + type,
        type,
        installationId: installationId(contextId, file),
        source: 'path',
        version: await versionOf(type, file),
        adapter: type === 'codex' ? 'index-only' : 'unverified'
      });
    if (managed[type]?.active && ['claude', 'dsh'].includes(type)) {
      const slot = String(managed[type].active);
      if (!/^[\w.-]+$/.test(slot) || slot === '.' || slot === '..') {
        partial.add('invalid-managed-slot');
        continue;
      }
      const bin = await executable(join(root, '.local/runtimes', type, slot, 'node_modules/.bin', type));
      const adapter =
        bin &&
        (await executable(
          join(
            root,
            '.local/runtimes',
            type,
            slot,
            'node_modules/.bin',
            type === 'claude' ? 'claude-agent-acp' : 'dsh'
          )
        ));
      if (bin && !adapter) partial.add('managed-adapter-unavailable');
      if (bin)
        runtimes.push({
          id: 'managed.' + type,
          type,
          installationId: installationId(contextId, bin),
          source: 'managed',
          version: await versionOf(type, bin),
          adapter: adapter ? 'acp' : 'unverified'
        });
      else partial.add('managed-slot-unavailable');
    }
  }
  function add(runtime, project, source, name, status) {
    if (!publicName(name)) {
      partial.add('name-omitted');
      return;
    }
    if (capabilities.size >= 10000) {
      partial.add('tools-limited');
      return;
    }
    const v = { runtime, ...(project ? { project } : {}), source, name, status };
    capabilities.set([runtime, project ?? '', source, name].join('/'), v);
  }
  for (const r of runtimes.filter((r) => r.id === 'path.claude')) {
    for (const n of await skillNames(join(probe.home ?? homedir(), '.claude', 'skills')))
      add(r.id, null, 'skill', n, 'declared');
  }
  for (const [project, dir] of Object.entries(policy.projects)) {
    if (
      !(await stat(dir).then(
        (s) => s.isDirectory(),
        () => false
      ))
    ) {
      partial.add('project-unavailable');
      continue;
    }
    for (const r of runtimes.filter((x) => x.type === 'claude')) {
      for (const n of await skillNames(join(dir, '.claude/skills')))
        add(r.id, project, 'skill', n, 'declared');
    }
    for (const r of runtimes.filter((x) => x.type === 'dsh')) {
      const names = await skillNames(join(dir, '.agents/skills'));
      for (const n of names) add(r.id, project, 'skill', n, 'declared');
    }
    if (runtimes.some((r) => r.id === 'path.codex')) {
      try {
        const report = await (probe.codex ?? codexReport)(dir, undefined, { includeSessions: false });
        for (const tool of report.tools)
          add(
            'path.codex',
            project,
            tool.source,
            tool.name,
            tool.source === 'project-script' ? 'declared' : 'reported'
          );
        for (const flag of report.partial) partial.add(flag);
      } catch {
        partial.add('codex-unavailable');
      }
    } else {
      const scripts = await projectScripts(dir);
      for (const r of runtimes.filter((x) => x.adapter === 'acp'))
        for (const t of scripts.tools) add(r.id, project, t.source, t.name, 'declared');
    }
  }
  for (const r of runtimes) if (r.type !== 'codex') partial.add(r.type + '-loaded-tools-unverified');
  const grants = [
    { action: 'inventory.refresh' },
    { action: 'cli.version' },
    ...Object.keys(policy.documents).map((resource) => ({ action: 'lark.document.read', resource }))
  ];
  return snapshotSpec.parse({
    version: 1,
    contextId,
    os: process.platform,
    observedAt: new Date().toISOString(),
    runtimes,
    cli,
    capabilities: [...capabilities.values()],
    grants,
    partial: [...partial].sort()
  });
}
export async function invokeHost(policy, action, resource) {
  if (action === 'cli.version') {
    if (![...runtimeTypes, ...familiar].includes(resource))
      throw new Error('Version probe is restricted to known commands');
    const file = await commandPath(resource);
    if (!file) throw new Error('Command not installed');
    return { action, resource, version: await commandVersion(resource, file) };
  }
  if (action !== 'lark.document.read' || !Object.hasOwn(policy.documents, resource ?? ''))
    throw new Error('This host has not authorized the requested action and resource');
  const bin = await commandPath('lark-cli');
  if (!bin) throw new Error('Feishu CLI unavailable');
  try {
    const { stdout } = await exec(
      bin,
      ['docs', '+fetch', '--as', 'user', '--doc', policy.documents[resource], '--doc-format', 'markdown'],
      {
        cwd: homedir(),
        timeout: 4500,
        maxBuffer: 256 * 1024,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            [
              'HOME',
              'PATH',
              'LANG',
              'USER',
              'TMPDIR',
              'XDG_CONFIG_HOME',
              'XDG_DATA_HOME',
              'LARK_CLI_PROFILE',
              'LARK_CLI_CONFIG_DIR'
            ].includes(key)
          )
        )
      }
    );
    const r = JSON.parse(stdout);
    if (r.ok === false || (r.code && r.code !== 0)) throw new Error('read rejected');
    const d = r.data ?? r,
      result = d.document ?? d;
    const content = result.content ?? result.markdown;
    if (typeof content !== 'string') throw new Error('unexpected document data');
    return {
      action,
      resource,
      source: 'external-document',
      text: content.slice(0, 6000),
      truncated: content.length > 6000
    };
  } catch {
    throw new Error(
      'Feishu read failed for the granted resource; check the local CLI identity and document access'
    );
  }
}
