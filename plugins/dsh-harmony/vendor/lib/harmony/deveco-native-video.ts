import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { embeddedNativeVideoResource, nativeVideoProfile, type NativeVideoQuality } from './native-video-resource';
import { HarmonyError } from './errors';
import { HosVideoPacketizer } from './media/hos-packets';
import type { HarmonyVideoConnection } from './types';
import { acquireDeviceLock, sharedDeviceLockDirectory } from './runtime/device-lock';

const ENDPOINT='localabstract:scrcpy_grpc_socket';
const active=new Set<string>();
const streaming=new Set<string>();
export function nativeDevEcoVideoStreaming(serial:string) { return streaming.has(serial); }
export const nativeRuntimeLockDirectory=()=>join(dirname(sharedDeviceLockDirectory()),'runtime-init');
export function ownedNativeVideoPids(output:string,extension:string): string[] {
 return output.split('\n').map(l=>l.trim().split(/\s+/)).filter(c=>/^\d+$/.test(c[1]??'')
  && /(?:^|\/)uitest$/.test(c[7]??'') && c[8]==='start-daemon' && c.includes(extension)).map(c=>c[1]);
}
export function ownedNativeVideoPid(output:string,extension:string) { return ownedNativeVideoPids(output,extension)[0]; }
export type NativeVideoCommand=(args: string[], operation: string, signal?: AbortSignal)=>Promise<string>;
export interface NativeVideoOptions {
 serial: string; cacheDirectory: string; signal?: AbortSignal; command: NativeVideoCommand;
 resourceDirectory?: string; quality?: NativeVideoQuality;
 /** Internal transport seam for lifecycle verification without a phone. */
 transport?: (port:number)=>{client:any;request:any};
 ownershipDirectory?: string;
 healthIntervalMs?: number;
 processAlive?: (pid:number)=>boolean;
 prepareAutomation?: ()=>Promise<boolean|void>;
 captureInitialFrame?: ()=>Promise<{data:Uint8Array;width:number;height:number}>;
 initialFrameIntervalMs?:number;
}
async function loopbackPort(): Promise<number> {
 return new Promise((accept,reject)=>{ const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const p=(server.address() as {port:number}).port;server.close(e=>e?reject(e):accept(p));}); });
}
/** Owns its exact daemon, files and forward. Never kills another uitest or launches the Java GUI. */
export async function openNativeDevEcoVideo(options: NativeVideoOptions): Promise<HarmonyVideoConnection> {
 const {serial,signal,command}=options;
 if(!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial)) throw new HarmonyError('INVALID_ARGUMENT','Invalid device serial');
 if(active.has(serial)) throw new HarmonyError('DEVICE_BUSY',`当前服务已有投屏连接（本机进程 ${process.pid}）。请关闭其他设备投屏标签后重试。`,{details:{ownerPid:process.pid}});
 active.add(serial);
 let pid:string|undefined,started=false,filesTouched=false,forward=false,call:any,client:any,request:any,closed=false,closing:Promise<void>|undefined;
 let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
 let firstTimer:ReturnType<typeof setTimeout>|undefined,watchdog:ReturnType<typeof setTimeout>|undefined,wakeupTimer:ReturnType<typeof setTimeout>|undefined,initialFrameTimer:ReturnType<typeof setTimeout>|undefined;
 let statsTimer:ReturnType<typeof setInterval>|undefined;
 const stats:{[key:string]:unknown}={hostPid:process.pid,startedAt:new Date().toISOString(),encodedPictures:0,videoBytes:0,state:'starting'};
 const statsPath=join(options.cacheDirectory,'native-video-status.json');
 let statsWrites=Promise.resolve();
 const saveStats=()=>{const body=JSON.stringify(stats,null,2);return statsWrites=statsWrites.then(()=>writeFile(statsPath,body)).catch(()=>{});};
 const id=randomUUID().replaceAll('-',''), extension=`libdsh_video_${id}.so`,remote=`/data/local/tmp/${extension}`,log=`/data/local/tmp/dsh-video-${id}.log`;
 let localPort=0;
 let ownerLock:ReturnType<typeof acquireDeviceLock>|undefined, runtimeLock:ReturnType<typeof acquireDeviceLock>|undefined;
 const ownershipDirectory=options.ownershipDirectory||join(dirname(sharedDeviceLockDirectory()),'native-video');
 const ownerPath=join(ownershipDirectory,`${createHash('sha256').update(serial).digest('hex')}.video.json`);
 const alive=options.processAlive||((p:number)=>{try{process.kill(p,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}});
 let wroteOwner=false;
 const saveOwner=async()=>{if(ownerLock){const temp=`${ownerPath}.${ownerLock.owner.nonce}.tmp`;try{await writeFile(temp,JSON.stringify({hostPid:process.pid,nonce:ownerLock.owner.nonce,extension,localPort,sessionId:id,startedAt:stats.startedAt}),{mode:0o600});await rename(temp,ownerPath);wroteOwner=true;}finally{await rm(temp,{force:true}).catch(()=>{});}}};
 let rejectStart:((e:Error)=>void)|undefined;
 const cleanup=()=>closing??=(async()=>{
  closed=true;clearTimeout(firstTimer);clearTimeout(watchdog);clearTimeout(wakeupTimer);clearTimeout(initialFrameTimer);clearInterval(statsTimer);signal?.removeEventListener('abort',abort);
  if(started&&stats.error){try{stats.daemonLogTail=(await command(['shell',`tail -c 4000 ${log}`],'native_video_failure_log')).slice(-4000);}catch{}}
  // Let the extension destroy its encoder and virtual screen before killing
  // the owned daemon. The deadline also bounds disconnected-device cleanup.
  if(call && client?.onEnd) await new Promise<void>(done=>{
   const timer=setTimeout(done,1200);
   try { client.onEnd(request, {deadline:Date.now()+1000},()=>{clearTimeout(timer);done();}); }
   catch { clearTimeout(timer);done(); }
  });
  const failures:string[]=[];
  try{call?.cancel();client?.close();}catch{failures.push('transport');}
  if(forward) await command(['fport','rm',`tcp:${localPort}`,ENDPOINT],'native_video_forward_cleanup').catch(()=>failures.push('forward'));
  if(started) {
   try {
    // uitest forks after startup: query the unique extension again rather than
    // assuming the first launcher PID is the final daemon PID.
    const owned=ownedNativeVideoPids(await command(['shell','ps -ef'],'native_video_cleanup_pid'),extension);
    stats.cleanupPids=owned;
    for(const ownedPid of owned) await command(['shell',`if grep -aq '${extension}' /proc/${ownedPid}/cmdline || grep -aq '${extension}' /proc/${ownedPid}/maps; then kill -9 ${ownedPid}; fi`],'native_video_daemon_cleanup');
    if(ownedNativeVideoPids(await command(['shell','ps -ef'],'native_video_cleanup_verify'),extension).length) failures.push('daemon');
   } catch { failures.push('daemon'); }
  }
  if(filesTouched)await command(['shell',`rm -f ${remote} ${log}`],'native_video_files_cleanup').catch(()=>failures.push('files'));
  active.delete(serial);streaming.delete(serial);
  try{runtimeLock?.release();}catch{failures.push('runtime-lock');}runtimeLock=undefined;
  if(ownerLock){
   if(wroteOwner&&!failures.length){try{const current=JSON.parse(await readFile(ownerPath,'utf8'));if(current.nonce===ownerLock.owner.nonce)await rm(ownerPath,{force:true});else failures.push('ownership');}catch{failures.push('ownership');}}
   try{ownerLock.release();}catch{failures.push('owner-lock');}ownerLock=undefined;
  }
  stats.state='closed';stats.closedAt=new Date().toISOString();stats.cleanup=failures.length?'uncertain':'complete';await saveStats();
  await writeFile(join(options.cacheDirectory,`native-video-${id}.json`),JSON.stringify(stats,null,2)).catch(()=>{});
  if(failures.length) throw new HarmonyError('DEVICE_BUSY','Native video cleanup is uncertain',{details:{cleanup:'uncertain',resources:failures,localPort}});
 })();
 const abort=()=>{const e=new HarmonyError('COMMAND_ABORTED','Video stream cancelled');rejectStart?.(e);try{controller?.error(e);}catch{} void cleanup().catch(()=>{});};
 try {
  if(signal?.aborted) throw new HarmonyError('COMMAND_ABORTED','Video start cancelled');
  const profile=nativeVideoProfile(options.quality);
  const resource=await embeddedNativeVideoResource(options.resourceDirectory);
  await mkdir(options.cacheDirectory,{recursive:true});
  stats.quality=options.quality||'balanced';stats.encoderProfile=profile;
  ownerLock=acquireDeviceLock(serial,ownershipDirectory);
  runtimeLock=acquireDeviceLock(serial,nativeRuntimeLockDirectory());
  const oldText=await readFile(ownerPath,'utf8').catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
  let old:any;
  try{old=oldText===undefined?undefined:JSON.parse(oldText);}catch{throw new HarmonyError('DEVICE_BUSY','Invalid native-video ownership record; explicit recovery is required');}
  if(oldText!==undefined&&(!old||typeof old!=='object'))throw new HarmonyError('DEVICE_BUSY','Invalid native-video ownership record; explicit recovery is required');
  if(old){
   if(!Number.isInteger(old.hostPid)||old.hostPid<1||!/^libdsh_video_[a-f0-9]{32}\.so$/.test(old.extension)||!Number.isInteger(old.localPort)||old.localPort<0||old.localPort>65535)throw new HarmonyError('DEVICE_BUSY','Invalid native-video ownership record; explicit recovery is required');
   if(alive(old.hostPid)&&old.hostPid!==process.pid)throw new HarmonyError('DEVICE_BUSY',`投屏由另一服务占用（本机进程 ${old.hostPid}）。请在该服务关闭投屏后重试。`,{details:{ownerPid:old.hostPid,sessionId:old.sessionId,localPort:old.localPort}});
   const orphanPids=ownedNativeVideoPids(await command(['shell','ps -ef'],'native_video_orphan_probe',signal),old.extension);
   for(const orphanPid of orphanPids)await command(['shell',`if grep -aq '${old.extension}' /proc/${orphanPid}/cmdline || grep -aq '${old.extension}' /proc/${orphanPid}/maps; then kill -9 ${orphanPid}; fi`],'native_video_orphan_cleanup',signal);
   if(ownedNativeVideoPids(await command(['shell','ps -ef'],'native_video_orphan_verify',signal),old.extension).length)throw new HarmonyError('DEVICE_BUSY','Previous native-video daemon could not be released');
   if(old.localPort)await command(['fport','rm',`tcp:${old.localPort}`,ENDPOINT],'native_video_orphan_forward').catch(()=>{});
   const oldId=old.extension.slice('libdsh_video_'.length,-3);
   await command(['shell',`rm -f /data/local/tmp/${old.extension} /data/local/tmp/dsh-video-${oldId}.log`],'native_video_orphan_files',signal);
   stats.recoveredOrphans=orphanPids.length;
  }
  await saveOwner();
  stats.resourceName=resource.resourceName;stats.resourceSha256=resource.hash;
  const existing=await command(['shell','ps -ef'],'native_video_existing',signal);
  if(existing.split('\n').some(l=>/uitest/.test(l)&&/libscreen_casting|libscrcpy|libdsh_video_/.test(l))) throw new HarmonyError('DEVICE_BUSY','Stop the other live video projection before opening this stream');
  // Establish the reusable UI agent before the encoder; never initialize it
  // over an active stream, because UiDriver.connect may restart uitest.
  const automationReady=await options.prepareAutomation?.();if(automationReady!==undefined)stats.automationReady=automationReady;
  localPort=await loopbackPort();
  await saveOwner();
  filesTouched=true;
  await command(['file','send',resource.file,remote],'native_video_send',signal);
  started=true;
  // The extension parses exact flag tokens; joined forms such as -scale2 are
  // silently ignored and leave full-resolution/high-rate defaults active.
  await command(['shell',`uitest start-daemon singleness --extension-name ${extension} -p ${localPort} -scale ${profile.scale} -frameRate ${profile.fps} -bitRate ${profile.bitRate} -screenId 0 -encodeType 0 -iFrameInterval 2000 -repeatInterval ${profile.repeatInterval} >${log} 2>&1 &`],'native_video_start',signal);
  // Query only the unique command. An aborted start is also cleaned below.
  for(let retry=0;retry<10;retry++){
   const ps=await command(['shell','ps -ef'],'native_video_pid');
   pid=ownedNativeVideoPid(ps,extension);
   if(pid) break;
   await new Promise(r=>setTimeout(r,100));
  }
  if(!pid) throw new HarmonyError('CAPABILITY_UNAVAILABLE','Native video extension could not start');
  stats.pid=pid;stats.extension=extension;stats.localPort=localPort;
  if(signal?.aborted) throw new HarmonyError('COMMAND_ABORTED','Video start cancelled');
  await command(['fport',`tcp:${localPort}`,ENDPOINT],'native_video_forward',signal);forward=true;
  if(options.transport) ({client,request}=options.transport(localPort));
  else {
   const require=createRequire(import.meta.url);
   const driverRequire=createRequire(require.resolve('hypium-driver/package.json'));
   // Pure generated protobuf modules: do not import UiDriver (which can restart unrelated daemons).
   const grpc=driverRequire('@grpc/grpc-js');
   const {ScrcpyServiceClient}=driverRequire('./build/lib/generated/scrcpy/scrcpy_grpc_pb.js');
   const {Empty}=driverRequire('./build/lib/generated/scrcpy/scrcpy_pb.js');
   request=new Empty();
   client=new ScrcpyServiceClient(`127.0.0.1:${localPort}`,grpc.credentials.createInsecure(),{'grpc.enable_http_proxy':0,'grpc.max_receive_message_length':8*1024*1024,'grpc.keepalive_time_ms':10_000,'grpc.keepalive_timeout_ms':3_000});
  }
  signal?.addEventListener('abort',abort,{once:true});
  // Prepare the display before waiting for the native RPC endpoint. Some
  // builds defer capture setup until a display/capture event is processed.
  try{await command(['shell','power-shell wakeup'],'native_video_display_prepare',signal);}catch(error){if(signal?.aborted)throw error;}
  // Capture a JPEG only if the encoder has not supplied a picture. Eager PNG
  // capture/pull/re-encode on every video start wastes work on changing screens.
  try{await new Promise<void>((accept,reject)=>client.waitForReady(Date.now()+12000,(e:Error)=>e?reject(e):accept()));}catch(error){throw new HarmonyError('CAPABILITY_UNAVAILABLE','投屏进程已启动，但视频通道未能连接。插件已回收本次连接，可重新接入。',{cause:error,retryable:true,details:{stage:'video_channel',localPort}});}
  if(closed||signal?.aborted) throw new HarmonyError('COMMAND_ABORTED','Video start cancelled');
  const packetizer=new HosVideoPacketizer(profile.fps,true);
  const videoStarted=Date.now();
  let ready=false;
  let encodedReady=false,encodedConfig:Buffer|undefined;
  let initialDimensions:string|undefined;
  let acceptReady:()=>void,rejectReady:(e:Error)=>void;
  const first=new Promise<void>((a,r)=>{acceptReady=a;rejectReady=r;rejectStart=r;});
  void first.catch(()=>{}); // Cancellation may arrive while wakeup is still awaiting HDC.
  const fail=(error:Error)=>{
   if(closed) return;
   stats.error=error.message;
   rejectReady(error);try{controller?.error(error);}catch{}void cleanup().catch(()=>{});
  };
  let paused=false;
  const armIdle=()=>{clearTimeout(watchdog);if(!closed&&!paused)watchdog=setTimeout(()=>{void (async()=>{try{const ps=await command(['shell','ps -ef'],'native_video_health',signal);if(closed)return;if(!ownedNativeVideoPids(ps,extension).length)throw new HarmonyError('CAPABILITY_UNAVAILABLE','Native video daemon exited');stats.healthCheckedAt=new Date().toISOString();armIdle();}catch(e){if(!closed)fail(e instanceof Error?e:new Error('Native video health check failed'));}})();},options.healthIntervalMs||15000);};
  const stream=new ReadableStream<Uint8Array>({
   start(c){controller=c;},
   pull(){if(!closed){paused=false;call?.resume();if(ready)armIdle();}},
   cancel(){return cleanup();},
  },{highWaterMark:512*1024,size:chunk=>chunk.byteLength});
  firstTimer=setTimeout(()=>fail(new HarmonyError('CAPABILITY_UNAVAILABLE','投屏视频通道已连接，但设备尚未输出画面。请确认手机已解锁后重新接入。',{retryable:true,details:{stage:'first_picture'}})),10_000);
  call=client.onStart(request);
  call.on('data',(reply:any)=>{
   if(closed) return;
   try {
    const payload:Uint8Array=reply.getPayloadMap().get('data')?.getValBytes_asU8()||new Uint8Array();
    if(payload.byteLength>8*1024*1024-9) throw new HarmonyError('INVALID_RESPONSE','Native video picture is too large');
    const bytes=Buffer.from(payload.buffer,payload.byteOffset,payload.byteLength);
    stats.videoBytes=Number(stats.videoBytes)+bytes.length;
    const packets=packetizer.push(bytes);
    // Preserve config before IDR, and wait for an actual picture before returning HTTP success.
    for(const packet of packets){
     const type=packet.readUInt32BE();
     if(type===2){encodedConfig=packet;if(encodedReady)controller!.enqueue(packet);continue;}
     if(type===3&&!encodedReady&&packet[8]!==1) continue;
     if(type===3){
      if(!encodedReady){if(!encodedConfig)continue;controller!.enqueue(encodedConfig);encodedReady=true;clearTimeout(initialFrameTimer);clearTimeout(wakeupTimer);stats.state='streaming';stats.firstEncodedPictureMs=Date.now()-videoStarted;}
      stats.encodedPictures=Number(stats.encodedPictures)+1;
      stats.elapsedMs=Date.now()-videoStarted;
      stats.encodedPicturesPerSecond=Number(stats.encodedPictures)/(Math.max(1,Number(stats.elapsedMs))/1000);
      if(!ready){ready=true;stats.state='streaming';stats.firstPictureMs=Date.now()-videoStarted;clearTimeout(firstTimer);clearTimeout(wakeupTimer);acceptReady();void saveStats();}
     }
     controller!.enqueue(packet);
    }
    if((controller!.desiredSize??0)<=0){paused=true;clearTimeout(watchdog);call.pause();}
   }catch(e){fail(e instanceof Error?e:new Error('Invalid native video data'));}
  });
  call.on('error',(e:Error)=>fail(e));
  call.on('end',()=>fail(new HarmonyError('CAPABILITY_UNAVAILABLE','Native video ended')));
  // The daemon is now visible to every profile's guard. Pointer input can
  // safely resume while we wait for the first change-driven picture.
  runtimeLock?.release();runtimeLock=undefined;
  // Match DevEco's channel-start wakeup. Unlike a power key or swipe, this
  // turns an asleep display on without toggling an already-awake screen or
  // navigating the current app. A static display may otherwise emit no IDR.
  const wakeup=async(operation:string)=>{try{await command(['shell','power-shell wakeup'],operation,signal);stats.displayWakeup='complete';}catch(error){if(signal?.aborted)throw error;stats.displayWakeup='unavailable';}};
  await wakeup('native_video_wakeup');
  // grpc-js returns onStart before the server has established its capture
  // surface. Reissue the idempotent wakeup once after that setup interval if
  // no picture arrived; never simulate touch to manufacture a first frame.
  if(!ready&&!closed)wakeupTimer=setTimeout(()=>{if(!ready&&!closed)void wakeup('native_video_wakeup_retry').catch(e=>fail(e));},1000);
  const initialFrame=async()=>{
   if(closed||encodedReady||!options.captureInitialFrame)return;
   try{
    if((controller!.desiredSize??0)>0){
     const frame=await options.captureInitialFrame();
     if(closed||encodedReady)return;
     if(!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<1||frame.height<1||frame.width>16384||frame.height>16384||!frame.data.length||frame.data.length>8*1024*1024)throw new HarmonyError('INVALID_RESPONSE','Invalid initial preview frame');
     const config=Buffer.alloc(22);config.writeUInt32BE(2,0);config.writeUInt32BE(14,4);config[8]=2;config.writeUInt32BE(frame.width,9);config.writeUInt32BE(frame.height,13);config.writeUInt32BE(1,17);config[21]=2; // explicit initial-preview flag
     const picture=Buffer.alloc(17+frame.data.length);picture.writeUInt32BE(3,0);picture.writeUInt32BE(9+frame.data.length,4);picture[8]=1;picture.writeBigUInt64BE(BigInt(Date.now())*1000n,9);Buffer.from(frame.data).copy(picture,17);
     const dimensions=`${frame.width}x${frame.height}`;if(initialDimensions!==dimensions){controller!.enqueue(config);initialDimensions=dimensions;}controller!.enqueue(picture);stats.initialPreviewPictures=Number(stats.initialPreviewPictures||0)+1;
     if(!ready){ready=true;stats.state='waiting_for_video';stats.firstPictureMs=Date.now()-videoStarted;clearTimeout(firstTimer);acceptReady();void saveStats();}
    }
   }catch(error){if(!closed)stats.initialPreviewError=error instanceof Error?error.message:'Initial preview failed';}
   if(!closed&&!encodedReady)initialFrameTimer=setTimeout(()=>void initialFrame(),options.initialFrameIntervalMs||2000);
  };
  if(options.captureInitialFrame&&!encodedReady&&!closed)initialFrameTimer=setTimeout(()=>void initialFrame(),1200);
  await first;
  streaming.add(serial);
  armIdle();
  statsTimer=setInterval(()=>{void saveStats();},10000);statsTimer.unref?.();
  return {stream,changeDriven:true,isLive:()=>!closed,close:async()=>{try{controller?.close();}catch{}await cleanup();}};
 }catch(e){stats.error=e instanceof Error?e.message:'Native video failed';await cleanup();throw e;}
}
