import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
const output=await build({entryPoints:['vendor/lib/harmony/deveco-native-video.ts'],bundle:true,format:'esm',platform:'node',packages:'external',outfile:'tests/.native-video-test.mjs'});
const {openNativeDevEcoVideo,ownedNativeVideoPid}=await import('./.native-video-test.mjs');
await rm('tests/.native-video-test.mjs');
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'dsh-native-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bytes=Buffer.alloc(64);bytes.set([127,69,76,70,2,1,1,0]);bytes.writeUInt16LE(183,18);
 await writeFile(join(dir,'libdsh-native-video.z.so'),bytes);
 await writeFile(join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,fileName:'libdsh-native-video.z.so',architecture:'aarch64',resourceName:'fixture.so',byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
 return {resourceDirectory:dir,cacheDirectory:dir,ownershipDirectory:join(dir,'owners')};
}
function fakeTransport(){
 const call=new EventEmitter();Object.assign(call,{cancel(){this.cancelled=true;},pause(){this.paused=true;},resume(){this.paused=false;}});
 const client={waitForReady(_d,cb){cb();},onStart(){setImmediate(()=>call.emit('started'));return call;},close(){this.closed=true;}};
 return {call,client,transport:()=>({client,request:{}})};
}
function ownedCommands(){
 const commands=[];let extension,stopped=false;
 return {commands,command:async(args)=>{commands.push(args);if(args[0]==='shell'&&args[1].startsWith('uitest')){extension=args[1].match(/--extension-name (\S+)/)[1];stopped=false;}
 if(args[0]==='shell'&&args[1].includes('kill -9'))stopped=true;
 if(args[0]==='shell'&&args[1]==='ps -ef'&&extension&&!stopped)return `shell 4321 1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness --extension-name ${extension}`;return '';
 }};
}
function ownerFile(f,serial){return join(f.ownershipDirectory,createHash('sha256').update(serial).digest('hex')+'.video.json');}
async function oldOwner(f,serial,record){await mkdir(f.ownershipDirectory,{recursive:true});await writeFile(ownerFile(f,serial),JSON.stringify(record));}
function data(call,bytes){call.emit('data',{getPayloadMap:()=>new Map([['data',{getValBytes_asU8:()=>bytes}]])});}
const annex=(...u)=>Buffer.concat(u.flatMap(x=>[Buffer.from([0,0,0,1]),x]));
const key=annex(Buffer.from('6742c01fda014016ec0440000003004000000c83c60c658','hex'),Buffer.from('68ce3c80','hex'),Buffer.from([0x65,1,2]));
test('the startup shell is never mistaken for the daemon that must be cleaned up',()=>{
 const name='libdsh_video_unique.so';
 const ps=`shell 1000 1 0 00:00:00 ? 00:00:00 sh -c uitest start-daemon singleness --extension-name ${name}\nshell 2000 1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness --extension-name ${name}`;
 assert.equal(ownedNativeVideoPid(ps,name),'2000');
 assert.equal(ownedNativeVideoPid(ps.split('\n')[0],name),undefined);
});
test('cancelling before the first frame settles and cleans only the owned PID and forward',async t=>{
 const f=await fixture(t),x=fakeTransport(),cmd=ownedCommands(),abort=new AbortController();
 x.call.once('started',()=>abort.abort());
 await assert.rejects(openNativeDevEcoVideo({...f,...cmd,transport:x.transport,serial:'test-abort',signal:abort.signal}),/cancelled/);
 assert.equal(x.call.cancelled,true);assert.equal(x.client.closed,true);
 assert.ok(cmd.commands.some(a=>a[0]==='fport'&&a[1]==='rm'));
 const kill=cmd.commands.find(a=>a[1]?.includes('kill -9'));assert.ok(kill[1].includes('/proc/4321/maps'));assert.ok(kill[1].includes('libdsh_video_'));
 assert.equal(cmd.commands.some(a=>a.join(' ').includes('killall')),false);
});
test('the stream becomes ready only with an IDR and pauses at its byte budget',async t=>{
 const f=await fixture(t),x=fakeTransport(),cmd=ownedCommands();
 x.call.once('started',()=>{data(x.call,key);for(let i=0;i<9;i++)data(x.call,annex(Buffer.concat([Buffer.from([0x41]),Buffer.alloc(65536)])));});
 const connection=await openNativeDevEcoVideo({...f,...cmd,transport:x.transport,serial:'test-stream'});
 const start=cmd.commands.find(a=>a[1]?.startsWith('uitest'))[1];
 assert.match(start,/-scale 2 -frameRate 24 -bitRate 3145728/);
 assert.doesNotMatch(start,/-scale2|-frameRate24/);
 assert.equal(x.call.paused,true);
 const reader=connection.stream.getReader();const config=await reader.read(),frame=await reader.read();
 assert.equal(Buffer.from(config.value).readUInt32BE(),2);assert.equal(Buffer.from(frame.value).readUInt32BE(),3);
 await reader.cancel();assert.equal(x.client.closed,true);
});
test('an existing DevEco video daemon is left alone before any device file is sent',async t=>{
 const f=await fixture(t),commands=[];
 await assert.rejects(openNativeDevEcoVideo({...f,serial:'test-busy',command:async a=>{commands.push(a);return 'shell 1111 1 0 ? ? ? uitest --extension-name libscreen_casting.z.so';}}),/other live video/);
 assert.equal(commands.some(a=>a[0]==='file'||a.join(' ').includes('kill -9')),false);
});

test('cleanup follows a forked child and asks the encoder to stop before cancelling',async t=>{
 const f=await fixture(t),x=fakeTransport();let extension,queried=0,stopped=false,ended=false;
 x.client.onEnd=(_r,_o,cb)=>{ended=true;cb();};
 const commands=[];
 const command=async args=>{
  commands.push(args);
  if(args[1]?.startsWith('uitest')) extension=args[1].match(/--extension-name (\S+)/)[1];
  if(args[1]?.includes('kill -9')) { assert.equal(ended,true);stopped=true; }
  if(args[1]==='ps -ef'&&extension&&!stopped) {
   const pid=queried++===0?'4321':'4322';
   return `shell ${pid} 1 0 00:00:00 ? 00:00:00 uitest start-daemon singleness --extension-name ${extension}`;
  }
  return '';
 };
 x.call.once('started',()=>data(x.call,key));
 const connection=await openNativeDevEcoVideo({...f,command,transport:x.transport,serial:'test-fork'});
 await connection.close();
 assert.ok(commands.some(a=>a[1]?.includes('kill -9 4322')));
 assert.equal(commands.some(a=>a[1]?.includes('kill -9 4321')),false);
});

test('dead host recovery cleans its exact daemon and forward before the new UI agent starts',async t=>{
 const f=await fixture(t),x=fakeTransport(),serial='test-orphan',extension='libdsh_video_'+'a'.repeat(32)+'.so';
 await oldOwner(f,serial,{hostPid:2147483647,extension,localPort:54321});
 const normal=ownedCommands();let orphan=true,prepared=false;
 const command=async(args,op)=>{if(op==='native_video_orphan_probe'||op==='native_video_orphan_verify')return orphan?`shell 1234 1 0 00:00:00 ? 00:00:00 uitest start-daemon --extension-name ${extension}`:'';if(op==='native_video_orphan_cleanup'){assert.ok(args[1].includes('kill -9 1234'));orphan=false;}if(op==='native_video_start')assert.equal(prepared,true);return normal.command(args);};
 x.call.once('started',()=>data(x.call,key));
 const c=await openNativeDevEcoVideo({...f,serial,command,transport:x.transport,prepareAutomation:async()=>{assert.equal(orphan,false);prepared=true;}});
 assert.ok(normal.commands.some(a=>a[0]==='fport'&&a[1]==='rm'&&a[2]==='tcp:54321'));
 await c.close();await assert.rejects(readFile(ownerFile(f,serial)),{code:'ENOENT'});
});

test('a live foreign host record survives a refused connection without killing its stream',async t=>{
 const f=await fixture(t),serial='test-live-owner',record={hostPid:42,extension:'libdsh_video_'+'b'.repeat(32)+'.so',localPort:53210};
 await oldOwner(f,serial,record);const cmd=ownedCommands();
 await assert.rejects(openNativeDevEcoVideo({...f,...cmd,serial,processAlive:()=>true}),e=>e.code==='DEVICE_BUSY'&&e.details?.ownerPid===42);
 assert.deepEqual(JSON.parse(await readFile(ownerFile(f,serial),'utf8')),record);
 assert.equal(cmd.commands.some(a=>a[1]?.includes('kill -9')||a[0]==='fport'),false);
});

test('a crash before port allocation is recoverable without attempting tcp:0',async t=>{
 const f=await fixture(t),serial='test-zero-port',x=fakeTransport(),cmd=ownedCommands();
 await oldOwner(f,serial,{hostPid:2147483647,extension:'libdsh_video_'+'c'.repeat(32)+'.so',localPort:0});
 x.call.once('started',()=>data(x.call,key));const c=await openNativeDevEcoVideo({...f,...cmd,serial,transport:x.transport});await c.close();
 assert.equal(cmd.commands.some(a=>a.includes('tcp:0')),false);
});

test('malformed ownership evidence is retained and never converted into a new session',async t=>{
 const f=await fixture(t),serial='test-malformed';await mkdir(f.ownershipDirectory,{recursive:true});await writeFile(ownerFile(f,serial),'{partial');const cmd=ownedCommands();
 await assert.rejects(openNativeDevEcoVideo({...f,...cmd,serial}),/Invalid native-video ownership/);
 assert.equal(await readFile(ownerFile(f,serial),'utf8'),'{partial');assert.equal(cmd.commands.some(a=>a[1]?.includes('kill -9')),false);
});

test('a static change-driven screen stays live; a lost daemon is detected and cleaned',async t=>{
 const f=await fixture(t),serial='test-health',x=fakeTransport(),cmd=ownedCommands();let absent=false,probes=0;
 const command=async(a,op)=>{if(op==='native_video_health'){probes++;if(absent)return '';}return cmd.command(a);};
 x.call.once('started',()=>data(x.call,key));const c=await openNativeDevEcoVideo({...f,serial,command,transport:x.transport,healthIntervalMs:25});
 const reader=c.stream.getReader();await reader.read();await reader.read();
 await new Promise(r=>setTimeout(r,90));assert.ok(probes>0);assert.notEqual(x.client.closed,true);
 absent=true;await assert.rejects(reader.read(),/daemon exited/);await c.close();assert.equal(x.client.closed,true);
});

test('channel-start wakeup obtains a first picture without navigating or touching the phone',async t=>{
 const f=await fixture(t),serial='test-wakeup-first',x=fakeTransport(),cmd=ownedCommands();let grpcStarted=false;
 x.call.once('started',()=>{grpcStarted=true;});
 const command=async(a,op)=>{const result=await cmd.command(a);if(op==='native_video_wakeup'){assert.equal(a[1],'power-shell wakeup');await new Promise(r=>setImmediate(r));assert.equal(grpcStarted,true);data(x.call,key);}return result;};
 const c=await openNativeDevEcoVideo({...f,serial,command,transport:x.transport});await c.close();
 assert.equal(cmd.commands.some(a=>/uiInput|uinput|keyEvent/.test(a.join(' '))),false);
});

test('a static screen starts with an explicit preview and switches to H264 at its first real IDR',async t=>{
 const f=await fixture(t),serial='test-initial-preview',x=fakeTransport(),cmd=ownedCommands();let captures=0;
 const c=await openNativeDevEcoVideo({...f,...cmd,serial,transport:x.transport,captureInitialFrame:async()=>{captures++;return {data:Buffer.from([255,216,255,217]),width:640,height:1440};},initialFrameIntervalMs:30});
 const reader=c.stream.getReader();const config=Buffer.from((await reader.read()).value),picture=Buffer.from((await reader.read()).value);
 assert.equal(config[8],2);assert.equal(config[21],2);assert.equal(picture.readUInt32BE(),3);
 data(x.call,key);const nativeConfig=Buffer.from((await reader.read()).value),nativePicture=Buffer.from((await reader.read()).value);
 assert.equal(nativeConfig[8],0);assert.equal(nativePicture.readUInt32BE(),3);assert.equal(nativePicture[8],1);
 const before=captures;await new Promise(r=>setTimeout(r,60));assert.equal(captures,before);await reader.cancel();
});
