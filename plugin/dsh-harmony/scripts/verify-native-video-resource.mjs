import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { nativeVideoCatalog } from './native-video-catalog.mjs';
import { protobufImports } from '../vendor/lib/harmony/native-video-elf.mjs';
export async function verifyNativeVideoResource(directory){
  const manifestPath=join(directory,'manifest.json');
  const info=await lstat(manifestPath).catch(e=>{if(e.code==='ENOENT')return;throw e;});
  if(!info){
    if(await lstat(join(directory,'libdsh-native-video.z.so')).catch(()=>undefined))throw Error('原生视频组件缺少清单。');
    return {present:false};
  }
  if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw Error('原生视频组件清单不符。');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const variants=manifest.schemaVersion===1?[{...manifest,id:'protobuf-legacy'}]:manifest.variants;
  if(![1,2].includes(manifest.schemaVersion)||manifest.architecture!=='aarch64'||!Array.isArray(variants)||!variants.length
    ||variants.length>nativeVideoCatalog.length||new Set(variants.map(v=>v?.id)).size!==variants.length)throw Error('原生视频组件清单不符。');
  const verified=[];
  for(const variant of variants){
    const known=nativeVideoCatalog.find(item=>item.id===variant?.id);
    if(!known||['fileName','resourceName','sha256','byteLength'].some(key=>known[key]!==variant[key]))throw Error('原生视频组件清单不符。');
    const file=join(directory,known.fileName),stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==known.byteLength)throw Error('原生视频组件大小不符。');
    const bytes=await readFile(file);
    if(createHash('sha256').update(bytes).digest('hex')!==known.sha256)throw Error('原生视频组件校验失败。');
    const symbols=protobufImports(bytes);if(!symbols.length)throw Error('原生视频组件缺少 protobuf 符号。');
    verified.push({id:known.id,byteLength:bytes.length,sha256:known.sha256,protobufImports:symbols.length});
  }
  return {present:true,byteLength:verified.reduce((sum,v)=>sum+v.byteLength,0),sha256:verified[0].sha256,variants:verified};
}
