import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from '../src/paths.mjs';
import { build } from '../scripts/release-archive.mjs';

// A distributable archive must not record a developer's npm mirror URL.
export const registry = 'https://registry.npmjs.org/';
export const packageName = '@shiyanjia/agent-network';
function run(command,args,cwd) {
  const result = spawnSync(command,args,{cwd,encoding:'utf8',env:{...process.env,npm_config_audit:'false'}});
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.slice(-1000));
  return result.stdout;
}
export async function packInternal() {
  const source = JSON.parse(await readFile(join(ROOT,'package.json'),'utf8'));
  const built = await build(ROOT);
  const archive = 'agent-network-' + source.version + '.tar.gz';
  const temp = await mkdtemp(join(tmpdir(),'agent-network-npm-'));
  try {
    for (const dir of ['release','bootstrap','bin','examples']) await mkdir(join(temp,dir));
    const spec = {name:packageName,version:source.version,description:source.description,license:'UNLICENSED',type:'module',
      engines:source.engines,repository:source.repository,homepage:source.homepage,bin:{'agent-network':'bin/agent-network.mjs','agent-network-release':'bootstrap/release.mjs'},
      dependencies:{'tar-stream':source.dependencies['tar-stream']},bundleDependencies:['tar-stream'],
      files:['release','bootstrap','bin','examples','README.md','npm-shrinkwrap.json'],publishConfig:{registry,access:'restricted'}};
    await writeFile(join(temp,'package.json'),JSON.stringify(spec,null,2)+'\n');
    // Seed npm with the reviewed application lock, then prune to the bootstrap's dependencies.
    const lock = JSON.parse(await readFile(join(ROOT,'package-lock.json'),'utf8'));
    lock.name=packageName;
    lock.packages['']={name:packageName,version:source.version,dependencies:spec.dependencies};
    await writeFile(join(temp,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
    run('npm',['install','--package-lock-only','--offline','--ignore-scripts','--no-audit','--no-fund'],temp);
    await rename(join(temp,'package-lock.json'),join(temp,'npm-shrinkwrap.json'));
    run('npm',['ci','--prefer-offline','--ignore-scripts','--no-audit','--no-fund'],temp);
    const guide=await readFile(join(ROOT,'docs/INSTALL.md'),'utf8');
    await writeFile(join(temp,'README.md'),guide.replace('../skills/agent-network/references/coordinator.md#按运行时接入',source.homepage));
    await copyFile(join(ROOT,'tools/internal-cli.mjs'),join(temp,'bin/agent-network.mjs'));
    for(const name of ['release.mjs','release-controller.mjs','release-store.mjs','release-service.mjs','release-lock.mjs','release-archive.mjs'])
      await copyFile(join(ROOT,'scripts',name),join(temp,'bootstrap',name));
    await copyFile(join(ROOT,'scripts/channel.mjs'),join(temp,'bootstrap/channel.mjs'));
    await copyFile(join(ROOT,'tools/host-bootstrap.mjs'),join(temp,'bootstrap/host-bootstrap.mjs'));
    for(const name of ['network.example.json','credentials.example.json'])
      await copyFile(join(ROOT,name),join(temp,'examples',name));
    for(const name of [archive,archive+'.sha256']) await copyFile(join(ROOT,'dist',name),join(temp,'release',name));
    // npm includes file modes in the tarball. Local instance permissions must not change its integrity.
    for (const entry of await readdir(temp, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) await chmod(join(entry.parentPath, entry.name), 0o644);
    }
    await chmod(join(temp, 'bin/agent-network.mjs'), 0o755);
    await chmod(join(temp, 'bootstrap/release.mjs'), 0o755);
    const [result] = JSON.parse(run('npm',['pack','--json','--ignore-scripts','--loglevel=error'],temp));
    const output=join(ROOT,'dist',result.filename);
    // Archives are tiny; verify every prior byte before replacing an identical local output.
    const bytes=await readFile(join(temp,result.filename));
    const old = await readFile(output).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
    if(old && !bytes.equals(old))throw new Error('Different npm package already exists for this version; increment the version');
    if(!old) await writeFile(output,bytes,{flag:'wx'});
    return {package:result.id,file:output,integrity:result.integrity,buildId:built.buildId,applicationSha256:built.sha256,registry};
  } finally { await rm(temp,{recursive:true,force:true}); }
}
if (import.meta.filename === resolve(process.argv[1] ?? '')) console.log(JSON.stringify(await packInternal()));
