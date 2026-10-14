import { readdir, readFile, writeFile, mkdir, copyFile, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..'), output=resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('Supply a new, empty staging directory.');
const rel=relative(root,output);
if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw Error('Stage outside the source repository.');
if(await lstat(output).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('Staging directory already exists; nothing is overwritten.');
const deniedDirectories=new Set(['node_modules','.git','artifacts','backups','.e2e','lib','.harmony-worker','oh_modules','.hvigor','.signing','signing']);
// Runtime lib code under vendor is SOURCE; only top-level built plugin lib is excluded.
const deniedFiles=/^(?:native-inputs\.json|client-inputs\.json|routes\.ts|local\.properties)$|(?:\.log|\.p12|\.p7b|\.cer|\.pem|\.key)$/i;
const files=[];
async function copyTree(source,target,pluginDepth=0){
  for(const entry of await readdir(source,{withFileTypes:true})){
    if(deniedDirectories.has(entry.name) && !(entry.name==='lib'&&source.includes(join('vendor'))))continue;
    if(entry.isSymbolicLink())throw Error(`Release source contains a symlink: ${join(source,entry.name)}`);
    if(entry.isDirectory()){
      await mkdir(join(target,entry.name),{recursive:true});await copyTree(join(source,entry.name),join(target,entry.name),pluginDepth+1);
    }else if(entry.isFile()){
      if(deniedFiles.test(entry.name)||entry.name.startsWith('.env')||(entry.name.startsWith('session')&&!entry.name.endsWith('.test.mjs')))continue;
      await copyFile(join(source,entry.name),join(target,entry.name));
      files.push({path:relative(output,join(target,entry.name)).replaceAll('\\','/'),sha256:createHash('sha256').update(await readFile(join(target,entry.name))).digest('hex')});
    }
  }
}
await mkdir(output,{recursive:true});
for(const name of ['plugins','scripts','docs']){await mkdir(join(output,name));await copyTree(join(root,name),join(output,name));}
for(const name of ['README.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md']){
  await copyFile(join(root,name),join(output,name));files.push({path:name,sha256:createHash('sha256').update(await readFile(join(output,name))).digest('hex')});
}
const packages=[];for(const name of ['dsh-harmony','dsh-e2e']){const p=JSON.parse(await readFile(join(output,'plugins',name,'package.json'),'utf8'));packages.push({name:p.name,version:p.version});}
await writeFile(join(output,'release-manifest.json'),JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),packages,host:'0.2.0-rc.2',platform:'Windows',format:'source: Node 24 and network dependency installation required',files:files.sort((a,b)=>a.path.localeCompare(b.path))},null,2)+'\n');
console.log(JSON.stringify({staging:output,files:files.length,packages,privateVendorResources:true},null,2));
