import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, LOCAL, readJson, writeJson } from './paths.mjs';
import { peerSummary } from './peers.mjs';
import { memberSummary } from './members.mjs';
import { networkGuide } from './network-guide.mjs';
import { networkVersion, buildId } from './version.mjs';

export async function teamStatus(catalog, scope, manager = false) {
  const sourceFiles = {};
  for (const name of (await readdir(resolve(ROOT, 'src'))).filter(x => x.endsWith('.mjs')).sort()) {
    sourceFiles[`src/${name}`] = createHash('sha256').update(await readFile(resolve(ROOT, 'src', name))).digest('hex').slice(0, 12);
  }
  return { networkVersion, buildId, networkRoot: ROOT, instanceRoot: catalog.root, networkSkill: await networkGuide(),
    models: catalog.config.models ?? {}, templates: catalog.config.templates,
    employees: catalog.list().agents.filter(agent => (agent.scope ?? null) === (scope ?? null)),
    runtimes: await readJson(resolve(LOCAL, 'runtime-state.json'), {}),
    ...await memberSummary(catalog, scope, manager), managedHosts:manager && !scope && catalog.federation?.hosts?(await catalog.federation.hosts.list()).map(h=>({alias:h.alias,runtimes:h.runtimes.map(r=>r.id),observedAt:h.observedAt})):[], networkNodes:[...await peerSummary(catalog.root,manager && !scope),...(manager && !scope && catalog.federation ? await catalog.federation.list():[])], federation:manager && !scope && catalog.federation?catalog.federation.transport.status():null, sourceFiles,
    channel: catalog.channel?.id ?? null,
    features: [...(catalog.config.features ?? ['任务执行与工作区','专业员工并行协作','执行中消息注入','员工配置管理','运行时更新和回滚','网络应用排空升级与回滚','按项目查询成员报告','主网络单节点互联']), ...(catalog.channel?.features ?? []),...(catalog.federation?['同机加密直连','跨机加密中转','外部回复关联原会话']:[])] };
}
export async function writeTeamContext(catalog, agent) {
  const status = await teamStatus(catalog, agent.scope, Boolean(agent.manager));
  const revision = createHash('sha256').update(JSON.stringify(status)).digest('hex').slice(0, 12);
  const role = agent.manager ? '负责人：按需读取规范链接的员工管理与续办说明。' : '专业员工：向本轮指定的派单人报告。';
  const pointer = `共享网络规范：${status.networkSkill.entrypoint}（修订 ${status.networkSkill.revision}）。首次协作或修订变化时读取；相对链接按规范所在目录解析。${role}\n本机网络 ${networkVersion}，能力快照 ${revision}：${resolve(agent.workspace, 'TEAM-CURRENT.json')}。`;
  await writeFile(resolve(agent.workspace, 'TEAM.md'), `# 团队说明入口\n\n协调者与专业员工共用一份网络规范。\n\n${pointer}\n`);
  await writeJson(resolve(agent.workspace, 'TEAM-CURRENT.json'), { revision, ...status });
  return pointer;
}
