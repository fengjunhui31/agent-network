import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentNetwork } from '../src/network.mjs';
import { startServer } from '../src/server.mjs';
import { ROOT, INSTANCE_ROOT, readJson, writeJson, redact } from '../src/paths.mjs';
import { networkGuide } from '../src/network-guide.mjs';
import { networkVersion, buildId } from '../src/version.mjs';

const tag=`guide-${Date.now()}`,root=resolve(INSTANCE_ROOT,'.local/verification',tag);
const config=await readJson(resolve(ROOT, 'network.example.json'));
config.agents={assistant:{template:'coordinator',runtime:'claude',model:'deepseek-v4.1-flash'},worker:{template:'engineer',runtime:'dsh',model:'deepseek-v4.1-flash'}};
await writeJson(resolve(root,'network.json'),config);
const guide=await networkGuide(),digest=createHash('sha256').update(await readFile(guide.entrypoint)).digest('hex');
const service=await startServer({network:await AgentNetwork.create({root}),saveEndpoint:false});
const report={mode:'real runtime and model; isolated employees; no WeCom connection',version:networkVersion,buildId,guide:guide.revision,passed:true,cases:[]};
try {
  await Promise.all(['assistant','worker'].map(async id=>{
    const agent=service.network.catalog.get(id),out=resolve(agent.workspace,'guide-answer.json');
    const question=id==='assistant'?'你已把工作交给专业同事。对方还需几分钟，你此时没有别的工作：现在怎么做，员工完成后如何验收并向用户回复？输出 decision、verifyTool、replyTool。decision 按你的选择填写 end_execution 或 wait_in_this_run。':'你受另一位成员委派。工作中有关键发现，随后会形成文件：怎么联系谁，最终如何交付？输出 decision、progressTool、recipient。recipient 按你的选择填写 delegator 或 end_user。';
    const entry={id,runtime:agent.runtime,passed:false};
    try {
      const started=await service.network.delegate({target:id,message:`这是本机规范读取验证。实际读取本轮提示指向的共享网络规范，负责人同时读取相关角色说明，不派发工作，不向外部通信。请计算共享 SKILL.md 原始字节的 SHA-256。${question} 把结果写为 UTF-8 JSON 到 ${out}，包含 skillFile、sha256、networkVersion 和上面要求的字段。最终文字说明已核对。`});
      const run=service.network.runs.get(started.runId);await run.settled;assert.equal(run.status,'completed',run.error);
      const answer=await readJson(out);assert.equal(answer.skillFile,guide.entrypoint);assert.equal(answer.sha256,digest);assert.equal(answer.networkVersion,networkVersion);
      assert.ok(JSON.stringify(run.events).includes(guide.entrypoint),'native execution actually accessed the shared guide');
      if(id==='assistant'){assert.match(answer.verifyTool,/get_result/);assert.match(answer.replyTool,/reply_user/);assert.equal(answer.decision,'end_execution');}
      else{assert.match(answer.progressTool,/send_message/);assert.equal(answer.recipient,'delegator');}
      Object.assign(entry,{passed:true,runId:run.runId,answer});
    }catch(error){entry.error=redact(error.message);report.passed=false;}
    report.cases.push(entry);console.log(JSON.stringify({id,passed:entry.passed,error:entry.error}));
  }));
} finally {await service.close();await writeJson(resolve(INSTANCE_ROOT,'verification',`${tag}.json`),report);}
console.log(JSON.stringify({passed:report.passed,report:`verification/${tag}.json`}));if(!report.passed)process.exitCode=1;
