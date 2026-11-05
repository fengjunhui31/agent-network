import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/paths.mjs';

const tracked = execFileSync('git',['ls-files','-z'],{cwd:ROOT,encoding:'utf8'}).split('\0').filter(Boolean);
if (!tracked.includes('src/server.mjs')) throw new Error('Run the source check in the project Git checkout, after staging new files');
const forbidden = /(^|\/)(?:\.local|\.git|current|releases|verification|dist|node_modules|__pycache__|\.env(?:\..*)?|\.npmrc|network\.json|credentials\.json|wecom\.json|relay(?:-identity|-status)?\.json|admission)(?:\/|$)|\.(?:key|pem|pyc|log)$/i;
const patterns = [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, /\bnpm_[A-Za-z0-9]{30,}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bsk-[A-Za-z0-9_-]{32,}\b/];
for (const name of tracked) {
  if(forbidden.test(name) || lstatSync(join(ROOT,name)).isSymbolicLink())throw new Error('Instance file or symlink in Git index: '+name);
  const contents = execFileSync('git',['show',':'+name],{cwd:ROOT,maxBuffer:5*1024*1024});
  if(patterns.some(p=>p.test(contents.toString('utf8'))))throw new Error('Credential-shaped value in Git index: '+name);
}
for (const folder of ['src','scripts','test','tools','packages/wecom/src','packages/wecom/test','packages/wecom/shared','packages/wecom/scripts','packages/relay','packages/relay/test']) for(const name of readdirSync(join(ROOT,folder)).filter(n=>n.endsWith('.mjs')))
  execFileSync(process.execPath,['--check',join(ROOT,folder,name)],{stdio:'inherit'});
const pkg=JSON.parse(readFileSync(join(ROOT,'package.json'))),lock=JSON.parse(readFileSync(join(ROOT,'package-lock.json')));
if(pkg.version!==lock.version || pkg.version!==lock.packages[''].version)throw new Error('Application and lockfile versions differ');
const adapter=JSON.parse(readFileSync(join(ROOT,'packages/wecom/package.json'))),adapterLock=JSON.parse(readFileSync(join(ROOT,'packages/wecom/package-lock.json')));
if(adapter.version!==adapterLock.packages[''].version || Object.keys(lock.packages).some(n=>n.includes('@wecom/')))
  throw new Error('Adapter lock/version or optional core dependency boundary differs');
const relay=JSON.parse(readFileSync(join(ROOT,'packages/relay/package.json'))),relayLock=JSON.parse(readFileSync(join(ROOT,'packages/relay/package-lock.json')));
if(relay.version!==relayLock.version || relay.version!==relayLock.packages[''].version || Object.entries(relay.dependencies).some(([k,v])=>relayLock.packages[''].dependencies[k]!==v))throw new Error('Relay manifest and lock differ');
console.log('Source checks passed for '+tracked.length+' tracked files.');
