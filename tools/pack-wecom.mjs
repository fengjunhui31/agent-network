import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../src/paths.mjs';
import { registry } from './pack-internal.mjs';
import { normalizePackageModes } from './package-modes.mjs';

const source=join(ROOT,'packages','wecom'),tmp=await mkdtemp(join(tmpdir(),'wecom-package-'));
try {
  const pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
  delete pkg.private;delete pkg.scripts;
  Object.assign(pkg,{files:['src','shared','docs','README.md','wecom.example.json','npm-shrinkwrap.json'],publishConfig:{registry,access:'restricted'},
    repository:JSON.parse(await readFile(join(ROOT,'package.json'),'utf8')).repository});
  await writeFile(join(tmp,'package.json'),JSON.stringify(pkg,null,2)+'\n');
  for(const dir of ['src','docs']) await cp(join(source,dir),join(tmp,dir),{recursive:true});
  await mkdir(join(tmp,'shared'));
  await copyFile(join(ROOT,'src/portable-io.mjs'),join(tmp,'shared/io.mjs'));
  await copyFile(join(ROOT,'src/sessions.mjs'),join(tmp,'shared/keys.mjs'));
  for(const n of ['README.md','wecom.example.json'])await copyFile(join(source,n),join(tmp,n));
  await copyFile(join(source,'package-lock.json'),join(tmp,'npm-shrinkwrap.json'));
  await normalizePackageModes(tmp);
  const [packed]=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts','--loglevel=error'],{cwd:tmp,encoding:'utf8'}));
  const file=join(ROOT,'dist',packed.filename);const bytes=await readFile(join(tmp,packed.filename));
  await mkdir(join(ROOT,'dist'),{recursive:true});
  const old=await readFile(file).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  if(old && !old.equals(bytes)) throw new Error('Different WeCom artifact already exists at this version');
  if(!old)await writeFile(file,bytes,{flag:'wx'});
  console.log(JSON.stringify({package:packed.id,file,integrity:packed.integrity}));
} finally {await rm(tmp,{recursive:true,force:true});}
