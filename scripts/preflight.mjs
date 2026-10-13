import { readFile, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyNativeVideoResource } from '../plugins/dsh-harmony/scripts/verify-native-video-resource.mjs';
const root=resolve(process.argv[2] || '.');
const profile=process.argv[3] && resolve(process.argv[3]);
if(process.versions.node.split('.')[0]!=='24')throw Error('Node 24 is required.');
if(process.platform!=='win32')throw Error('This release is validated on Windows only.');
if(process.arch!=='x64')throw Error('This release is validated on Windows x64 only; Windows ARM64 requires separate native-dependency validation.');
const packages=[];
for(const name of ['dsh-harmony','dsh-e2e']){
  const directory=join(root,'plugins',name);
  const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
  const lock=JSON.parse(await readFile(join(directory,'package-lock.json'),'utf8'));
  if(pkg.name!==name||lock.packages?.['']?.name!==name||lock.version!==pkg.version)throw Error(`${name}: manifest/lock identity mismatch.`);
  for(const key of ['dependencies','devDependencies','peerDependencies']){
    const sorted=value=>JSON.stringify(Object.entries(value||{}).sort(([a],[b])=>a.localeCompare(b)));
    if(sorted(pkg[key])!==sorted(lock.packages[''][key]))throw Error(`${name}: ${key} differ from the lockfile.`);
  }
  for(const file of ['cordis.patch.yml','scripts/build.mjs'])await lstat(join(directory,file));
  packages.push({name:pkg.name,version:pkg.version});
}
if(profile){
  const pkg=JSON.parse(await readFile(join(profile,'package.json'),'utf8'));
  if(!pkg.dsh?.profile||!Array.isArray(pkg.dsh.profile.bundles))throw Error('Target is not an initialized DSH profile.');
}
const manifestPath=join(root,'release-manifest.json');
const manifestStat=await lstat(manifestPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
if(manifestStat){
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.files))throw Error('Unsupported release manifest.');
  for(const file of manifest.files){
    if(typeof file.path!=='string'||!file.path||isAbsolute(file.path))throw Error('Invalid release path.');
    const target=resolve(root,file.path), rel=relative(root,target);
    if(rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel))throw Error('Release path escapes the package.');
    const stat=await lstat(target);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error(`Non-regular release file: ${file.path}`);
    if(createHash('sha256').update(await readFile(target)).digest('hex')!==file.sha256)throw Error(`Release checksum mismatch: ${file.path}`);
  }
}
const native=await verifyNativeVideoResource(join(root,'plugins/dsh-harmony/resources/native-video'));
console.log(JSON.stringify({preflight:'passed',node:process.versions.node,platform:process.platform,architecture:process.arch,packages,releaseChecksums:!!manifestStat,nativeVideo:native.present?'verified ARM64 phone resource':'missing: screenshot preview is available; live H.264 needs the private resource',mutates:false},null,2));
