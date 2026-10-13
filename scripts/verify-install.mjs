import { readFile, realpath, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const profile=resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('Provide a profile directory.');
const pkg=JSON.parse(await readFile(join(profile,'package.json'),'utf8'));
const packages=[];
for(const name of ['dsh-harmony','dsh-e2e']){
  if(!pkg.dependencies?.[name]||!pkg.dsh?.profile?.bundles?.includes(name))throw Error(`${name} is not registered as dependency and bundle.`);
  const directory=await realpath(join(profile,'node_modules',name));
  const installed=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
  if(installed.name!==name)throw Error(`${name}: installed identity mismatch.`);
  for(const file of [installed.main,'lib/client.js','cordis.patch.yml'])await access(join(directory,file));
  if(name==='dsh-harmony')await access(join(directory,'.harmony-worker/harmony/runtime/worker-entry.js'));
  packages.push({name,version:installed.version,directory,registration:'verified'});
}
console.log(JSON.stringify({profile,packages,runtime:'not checked: cold startup and a message/tool/result flow are still required'},null,2));
