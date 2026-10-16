import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, join } from 'node:path';
import { getHarmonyDeviceManager } from '@/lib/harmony';
import { resolveHarmonyStorage, safeHarmonyDeviceName } from '@/lib/harmony/artifacts';
import { harmonyErrorResponse, requireHarmonyAccess } from '../../_shared';

export async function GET(request: Request) {
  const denied=requireHarmonyAccess(request);if(denied)return denied;
  try {
    const params=new URL(request.url).searchParams,serial=params.get('serial')||'',filename=params.get('filename')||'';
    if(!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial)||basename(filename)!==filename||!filename.startsWith(safeHarmonyDeviceName(serial)+'-')||!/^[A-Za-z0-9._-]{1,180}\.mp4$/.test(filename))return new Response('Invalid recording',{status:400});
    const path=join(resolveHarmonyStorage(getHarmonyDeviceManager().getConfig()).recordingDirectory,filename),info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||!info.size)return new Response('Recording unavailable',{status:404});
    const headers:Record<string,string>={'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
    let start=0,end=info.size-1,status=200;const range=request.headers.get('range');
    if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||!match[1]&&!match[2])return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}});
      if(!match[1])start=Math.max(0,info.size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}});
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length']=String(end-start+1);
    const stream=createReadStream(path,{start,end});const abort=()=>stream.destroy();request.signal.addEventListener('abort',abort,{once:true});stream.once('close',()=>request.signal.removeEventListener('abort',abort));if(request.signal.aborted)stream.destroy();
    return new Response(Readable.toWeb(stream) as ReadableStream,{status,headers});
  } catch(error){return harmonyErrorResponse(error);}
}
