// This installer also ships in the npm bootstrap and only uses Node built-ins.
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.LAN_INSTANCE_ROOT && resolve(process.env.LAN_INSTANCE_ROOT);
const registry=process.env.npm_config_registry || 'https://registry.npmjs.org/';
async function save(configFile,value) {
  const tmp=configFile+'.'+randomUUID()+'.tmp';
  try { await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,configFile); }
  finally {await rm(tmp,{force:true});}
}
try {
  if(!root) throw new Error('Set LAN_INSTANCE_ROOT to the target instance');
  const [action='status',id,spec]=process.argv.slice(2);
  const local=resolve(root,'.local'); const file=resolve(local,'channel.json');
  const instance=JSON.parse(await readFile(resolve(root,'network.json'),'utf8'));
  if(!instance.agents)throw new Error('Select an initialized network instance');
  await mkdir(local,{recursive:true,mode:0o700});
  if(action==='request'){
    if(process.env.LAN_AGENT_ID)throw new Error('Local owner command');
    const [groupId,key,requestFile]=process.argv.slice(3);
    const ep=JSON.parse(await readFile(resolve(local,'release-control.json'),'utf8'));
    if(new URL(ep.url).hostname!=='127.0.0.1')throw new Error('Expected local owner endpoint');
    const res=await fetch(ep.url+'/channel/owner',{method:'POST',headers:{authorization:'Bearer '+ep.token,'content-type':'application/json'},
      body:JSON.stringify({action:'request',groupId,key,message:await readFile(resolve(requestFile),'utf8')}),signal:AbortSignal.timeout(8000)});
    const result=await res.json();if(!res.ok)throw new Error(result.error);console.log(JSON.stringify(result));
  } else if(action==='status') {
    const previous=await readFile(file,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return '{"enabled":false}';});
    console.log(previous.trim());
  } else if(action==='disable') {
    await save(file,{enabled:false});console.log('Channel disabled for the next service start');
  } else if(action==='install') {
    if(!/^[a-z][a-z0-9-]{0,40}$/.test(id ?? '') || !spec) throw new Error('Use install CHANNEL /absolute/package.tgz or install CHANNEL @shiyanjia/agent-network-CHANNEL@VERSION');
    const name='@shiyanjia/agent-network-'+id;
    const localFile=(spec.startsWith('.') || isAbsolute(spec)) && spec.endsWith('.tgz');
    if(!localFile && (!spec.startsWith(name+'@') || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec.slice(name.length+1))))
      throw new Error('Provide a local npm artifact or an exact internal package version');
    const slot=randomUUID();const directory=resolve(local,'channels',slot);
    await mkdir(directory,{recursive:true,mode:0o700});
    try {
      await writeFile(resolve(directory,'package.json'),JSON.stringify({private:true}));
      execFileSync('npm',['install','--prefix',directory,'--ignore-scripts','--no-audit','--no-fund','--prefer-offline','--registry',registry,localFile?resolve(spec):spec],{stdio:'inherit'});
      const pkgdir=resolve(directory,'node_modules',name);
      const pkg=JSON.parse(await readFile(resolve(pkgdir,'package.json'),'utf8'));
      if(pkg.name!==name || pkg.agentNetworkChannel?.id!==id || pkg.agentNetworkChannel?.apiVersion!==1 || typeof pkg.main!=='string')
        throw new Error('Package does not declare the requested channel API');
      const actualRoot=await realpath(pkgdir),entry=await realpath(resolve(actualRoot,pkg.main));
      if (!entry.startsWith(actualRoot+sep) || typeof (await import(pathToFileURL(entry).href)).startChannel!=='function')
        throw new Error('Package entry does not export a channel factory');
      if(pkg.agentNetworkChannel.exampleConfig === id+'.example.json') {
        try { await copyFile(resolve(pkgdir,id+'.example.json'),resolve(local,id+'.example.json'),constants.COPYFILE_EXCL); }
        catch(e){if(e.code!=='EEXIST')throw e;}
      }
      await save(file,{enabled:true,id,slot,version:pkg.version});
      console.log('Installed',pkg.name+'@'+pkg.version,'for the next service start');
    } catch(e) {await rm(directory,{recursive:true,force:true});throw e;}
  } else throw new Error('Commands: status | install ID SPEC | disable | request GROUP_ID KEY MESSAGE_FILE');
} catch(e){console.error(e.message);process.exitCode=1;}
