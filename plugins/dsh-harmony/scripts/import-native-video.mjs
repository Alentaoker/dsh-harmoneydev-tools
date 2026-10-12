import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import JSZip from 'jszip';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
function arg(name){const at=args.indexOf(name);return at<0?undefined:args[at+1];}
const jarPath=arg('--jar');
if(!jarPath||!isAbsolute(jarPath))throw new Error('请用 --jar 提供本机 screenCastingResource.jar 的绝对路径。');
const destination=resolve(arg('--destination')||join(root,'resources','native-video'));
const resourceName='libscrcpy/libscrcpy_server_unix_6.6-20260418.z.so';
const expectedHash='98bbc964fef1c4d17b446ec717102b855d09224b23fc1872bf70e1f928d010dd';
const hash=b=>createHash('sha256').update(b).digest('hex');
const source=await readFile(jarPath);
if(source.length>128*1024*1024)throw new Error('视频资源包超过大小限制。');
const outer=await JSZip.loadAsync(source);
const sdkName=Object.keys(outer.files).find(n=>/^lib\/hosScrcpy-[^/]+\.jar$/.test(n));
if(!sdkName)throw new Error('资源包中没有 HOScrcpy SDK。');
const sdkEntry=outer.file(sdkName);
if(sdkEntry._data?.uncompressedSize>128*1024*1024)throw new Error('SDK超过大小限制。');
const sdkBytes=await sdkEntry.async('nodebuffer'),sdk=await JSZip.loadAsync(sdkBytes);
const entry=sdk.file(resourceName);
if(!entry||entry._data?.uncompressedSize>2*1024*1024)throw new Error('没有找到已适配的 ARM64 视频组件。');
const bytes=await entry.async('nodebuffer');
if(hash(bytes)!==expectedHash||bytes.length!==268471)throw new Error('组件哈希与已验收版本不符，未导入。');
await mkdir(destination,{recursive:true});
const fileName='libdsh-native-video.z.so',temp=join(destination,`.native-${randomUUID()}.tmp`);
try{await writeFile(temp,bytes);await rename(temp,join(destination,fileName));}finally{await rm(temp,{force:true});}
await writeFile(join(destination,'manifest.json'),JSON.stringify({schemaVersion:1,fileName,architecture:'aarch64',resourceName,
  byteLength:bytes.length,sha256:expectedHash,sourceSdk:sdkName,sourceSdkSha256:hash(sdkBytes),sourceArchiveSha256:hash(source),
  distribution:'private personal installation; original vendor rights retained'},null,2)+'\n');
console.log(JSON.stringify({imported:true,byteLength:bytes.length,sha256:expectedHash,destination,
  note:'本机安装包现已内置组件，投屏启动不再读取 DevEco Testing。组件用于本人的私有安装，不适用本项目 MIT 许可。'}));
