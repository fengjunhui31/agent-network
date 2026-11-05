import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const safeLine = (value, size) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\b(?:sk-|ghp_|Bearer )\S{12,}/gi, '[redacted]').trim().slice(0, size) : '';
const sources = ['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'];

class AppServer {
  constructor(cwd) {
    this.pending = new Map(); this.next = 1;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAN_')));
    this.child = spawn('codex', ['app-server','--listen','stdio://'], { cwd, env, stdio:['pipe','pipe','ignore'] });
    const fail = () => {
      this.closed = true;
      for (const request of this.pending.values()) request.reject(new Error('Codex app-server closed; check the local CLI'));
      this.pending.clear();
    };
    this.child.once('error', fail); this.child.once('exit', fail);
    this.child.stdin.on('error', fail);
    this.lines = createInterface({ input:this.child.stdout });
    this.lines.on('line', line => {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame.method) return;
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(pending.method + ' failed (' + frame.error.code + ')'));
      else pending.resolve(frame.result);
    });
  }
  async call(method, params) {
    if (this.closed) throw new Error('Codex app-server is unavailable');
    const id = this.next++;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, method });
        timer = setTimeout(() => reject(new Error(method + ' timed out')), 12000);
        this.child.stdin.write(JSON.stringify({ method, params, id }) + '\n');
      });
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async initialize() {
    await this.call('initialize', { clientInfo:{ name:'agent_network_directory',title:'Local project directory',version:'1' } });
    this.child.stdin.write(JSON.stringify({ method:'initialized' }) + '\n');
  }
  close() {
    this.lines.close(); this.child.stdin.end(); this.child.kill('SIGTERM');
    const stop = setTimeout(() => { if (this.child.exitCode === null && !this.child.signalCode) this.child.kill('SIGKILL'); }, 1500);
    stop.unref();
  }
}

export async function projectScripts(project) {
  try {
    const manifest = JSON.parse(await readFile(resolve(project,'package.json'),'utf8'));
    const scripts = manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts) ? Object.keys(manifest.scripts) : [];
    return { tools: scripts.map(name => ({ name:safeLine(name,180),source:'project-script' })).filter(x => x.name), partial:[] };
  } catch (e) { return { tools:[], partial:e.code === 'ENOENT' ? [] : ['scripts-unavailable'] }; }
}

export async function codexReport(project, suppliedClient) {
  const client = suppliedClient ?? new AppServer(project);
  try {
    if (!suppliedClient) await client.initialize();
    const sessions = new Map(), tools = new Map(), partial = new Set();
    function addTool(name, source) {
      name = safeLine(name, 180);
      if (!name) return;
      if (tools.size >= 1200) { partial.add('tools-limited'); return; }
      tools.set(source + '/' + name, { name,source });
    }
    for (const archived of [false,true]) {
      const seen = new Set(); let cursor;
      do {
        const page = await client.call('thread/list', { cwd:project,archived,sourceKinds:sources,modelProviders:[],useStateDbOnly:true,
          sortKey:'updated_at',limit:100,...(cursor ? {cursor} : {}) });
        for (const thread of page.data) {
          if (thread.cwd !== project || !thread.id) continue;
          if (sessions.size >= 1000 && !sessions.has(thread.id)) { partial.add('sessions-limited'); break; }
          const title = safeLine(thread.name,320);
          sessions.set(thread.id, { id:thread.id,purpose:title || null,source:title ? 'title' : 'unknown',archived,
            ...(Number.isFinite(thread.updatedAt) ? {updatedAt:new Date(thread.updatedAt * 1000).toISOString()} : {}) });
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Codex returned a repeating thread cursor');
        seen.add(cursor);
      } while (cursor && !partial.has('sessions-limited'));
      if (partial.has('sessions-limited')) break;
    }
    const scriptInfo = await projectScripts(project);
    for (const t of scriptInfo.tools) addTool(t.name, t.source);
    for (const flag of scriptInfo.partial) partial.add(flag);
    try {
      const answer = await client.call('skills/list', { cwds:[project] });
      const row = answer.data.find(r => r.cwd === project);
      if (!row || row.errors?.length) partial.add('skills-unavailable');
      for (const skill of row?.skills ?? []) if (skill.enabled !== false) addTool(skill.name, 'skill');
    } catch { partial.add('skills-unavailable'); }
    try {
      const seen = new Set(); let cursor;
      do {
        const page = await client.call('mcpServerStatus/list', { detail:'toolsAndAuthOnly',limit:50,...(cursor ? {cursor} : {}) });
        for (const server of page.data) {
          if (server.toolsError) partial.add('mcp-unavailable');
          for (const name of Object.keys(server.tools ?? {})) addTool(server.name + '.' + name, 'mcp');
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Repeating MCP cursor');
        seen.add(cursor);
      } while (cursor && !partial.has('tools-limited'));
    } catch { partial.add('mcp-unavailable'); }
    return { project,sessions:[...sessions.values()],tools:[...tools.values()],partial:[...partial] };
  } finally { if (!suppliedClient) client.close(); }
}
