import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute, basename } from 'node:path';
import JSZip from 'jszip';
import { nativeVideoCatalog } from './native-video-catalog.mjs';
import { verifyNativeVideoResource } from './verify-native-video-resource.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
function arg(name){const at=args.indexOf(name);return at<0?undefined:args[at+1];}
const jarPath=arg('--jar');
if(!jarPath||!isAbsolute(jarPath))throw new Error('请用 --jar 提供原厂 screenCastingResource.jar 或 HOScrcpy SDK jar 的绝对路径。');
const destination=resolve(arg('--destination')||join(root,'resources','native-video'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const source=await readFile(jarPath);
if(source.length>128*1024*1024)throw new Error('视频资源包超过大小限制。');
const outer=await JSZip.loadAsync(source);
const nestedName=Object.keys(outer.files).find(n=>/^lib\/hosScrcpy-[^/]+\.jar$/.test(n));
const sdkEntry=nestedName?outer.file(nestedName):undefined;
if(sdkEntry?._data?.uncompressedSize>128*1024*1024)throw new Error('SDK超过大小限制。');
const sdkBytes=sdkEntry?await sdkEntry.async('nodebuffer'):source;
const sdk=sdkEntry?await JSZip.loadAsync(sdkBytes):outer;
const imported=[];
for(const known of nativeVideoCatalog){
  const entry=sdk.file(known.resourceName);if(!entry)continue;
  if(entry._data?.uncompressedSize>2*1024*1024)throw Error('组件超过大小限制。');
  const bytes=await entry.async('nodebuffer');
  if(hash(bytes)!==known.sha256||bytes.length!==known.byteLength)throw Error('组件哈希与原厂版本不符，未导入。');
  imported.push({known,bytes});
}
if(!imported.length)throw Error('资源包中没有支持的 ARM64 视频组件，未导入。');
const previous=await verifyNativeVideoResource(destination);
let variants=[];
if(previous.present){
  const manifest=JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'));
  variants=manifest.schemaVersion===1?[{...manifest,id:'protobuf-legacy'}]:manifest.variants;
}
await mkdir(destination,{recursive:true});
for(const {known,bytes} of imported){
  const temp=join(destination,`.native-${randomUUID()}.tmp`);
  try{await writeFile(temp,bytes);await rename(temp,join(destination,known.fileName));}finally{await rm(temp,{force:true});}
  variants=variants.filter(item=>item.id!==known.id);
  variants.push({...known,sourceSdk:nestedName||basename(jarPath),sourceSdkSha256:hash(sdkBytes),sourceArchiveSha256:hash(source)});
}
variants.sort((a,b)=>nativeVideoCatalog.findIndex(item=>item.id===a.id)-nativeVideoCatalog.findIndex(item=>item.id===b.id));
const tempManifest=join(destination,`.manifest-${randomUUID()}.tmp`);
try{await writeFile(tempManifest,JSON.stringify({schemaVersion:2,architecture:'aarch64',variants,
  distribution:'original vendor rights retained; components are unmodified'},null,2)+'\n');await rename(tempManifest,join(destination,'manifest.json'));}
finally{await rm(tempManifest,{force:true});}
console.log(JSON.stringify({imported:imported.map(item=>item.known.id),...await verifyNativeVideoResource(destination),destination}));
