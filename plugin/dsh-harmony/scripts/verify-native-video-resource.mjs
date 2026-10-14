import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export async function verifyNativeVideoResource(directory){
  const file=join(directory,'libdsh-native-video.z.so');
  const info=await lstat(file).catch(e=>{if(e.code==='ENOENT')return;throw e;});
  if(!info)return {present:false};
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  if(!info.isFile()||info.isSymbolicLink()||info.size!==268471||manifest.schemaVersion!==1
    ||manifest.architecture!=='aarch64'||manifest.fileName!=='libdsh-native-video.z.so'
    ||manifest.sha256!=='98bbc964fef1c4d17b446ec717102b855d09224b23fc1872bf70e1f928d010dd')throw new Error('原生视频组件清单不符。');
  const bytes=await readFile(file);
  if(bytes.readUInt32BE(0)!==0x7f454c46||bytes[4]!==2||bytes[5]!==1||bytes.readUInt16LE(18)!==183
    ||createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('原生视频组件校验失败。');
  return {present:true,byteLength:bytes.length,sha256:manifest.sha256};
}
