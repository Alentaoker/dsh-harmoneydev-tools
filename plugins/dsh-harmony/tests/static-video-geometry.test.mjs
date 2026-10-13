import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
const file=new URL(`./.static-geometry-${process.pid}.mjs`,import.meta.url);
const output=await build({entryPoints:['vendor/lib/harmony/device-manager.ts'],bundle:true,format:'esm',platform:'node',packages:'external',write:false,alias:{'@earendil-works/pi-ai':path.resolve('src/pi-ai.ts'),'@earendil-works/pi-coding-agent':path.resolve('src/pi-sdk.ts')},plugins:[{name:'unused-session-reader-test-boundary',setup(b){b.onLoad({filter:/src[\\/]pi-sdk\.ts$/},async args=>({contents:(await readFile(args.path,'utf8'))+'\nexport const SessionManager={open(){throw Error("Session reading is outside this geometry test")}};export function buildContextEntries(){throw Error("Session reading is outside this geometry test")}',loader:'ts',resolveDir:path.dirname(args.path)}));}}]});
await writeFile(file,output.outputFiles[0].contents);const {HarmonyDeviceManager}=await import(file.href);test.after(()=>rm(file,{force:true}));
test('static change-driven video keeps coordinates valid only while its transport and geometry remain valid',async()=>{
 let now=10000,live=true,rotated=false;
 const config=Buffer.alloc(21);config.writeUInt32BE(2);config.writeUInt32BE(13,4);config[8]=2;config.writeUInt32BE(100,9);config.writeUInt32BE(200,13);config.writeUInt32BE(1,17);
 const picture=Buffer.alloc(18);picture.writeUInt32BE(3);picture.writeUInt32BE(10,4);picture[8]=1;
 const backend={kind:'test',hdcPath:'test',listDevices:async()=>[{serial:'TEST-STATIC',state:'online',capabilities:{}}],displayGeometry:async()=>({nativeWidth:rotated?200:100,nativeHeight:rotated?100:200,displayId:'0',displayRotation:rotated?90:0}),openVideoStream:async()=>({changeDriven:true,isLive:()=>live,stream:new ReadableStream({start(c){c.enqueue(config);c.enqueue(picture);}}),close:async()=>{live=false;}}),dispose:async()=>{}};
 const manager=new HarmonyDeviceManager({backend,now:()=>now});const connection=await manager.openVideoStream({serial:'TEST-STATIC'}),reader=connection.stream.getReader();
 try{await reader.read();await reader.read();const initial=await manager.getFrameGeometry('TEST-STATIC','video');now+=20000;assert.equal((await manager.getFrameGeometry('TEST-STATIC','video')).geometryId,initial.geometryId);rotated=true;await assert.rejects(manager.getFrameGeometry('TEST-STATIC','video'),e=>e.code==='STALE_SNAPSHOT');rotated=false;now=10010;live=false;await assert.rejects(manager.getFrameGeometry('TEST-STATIC','video'),e=>e.code==='STALE_SNAPSHOT');}
 finally{await reader.cancel();await connection.close();await manager.dispose();}
});
test('semantic observations keep HiLog alive; an explicit device stop closes it',async()=>{
 let logSignal,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const backend={kind:'test',hdcPath:'test',listDevices:async()=>[{serial:'TEST-LOGS',state:'online',capabilities:{uiTree:true}}],snapshot:async()=>({nodes:[],quality:{treeStatus:'valid',scopeComplete:true}}),streamLogs:async(_s,_cb,signal)=>{logSignal=signal;started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},dispose:async()=>{}};
 const manager=new HarmonyDeviceManager({backend}),controller=new AbortController();
 const stream=manager.streamLogs('TEST-LOGS',()=>{},controller.signal);
 try{await ready;await manager.snapshot({serial:'TEST-LOGS',includeTree:true,includeScreenshot:false});assert.equal(logSignal.aborted,false);await manager.stopDevice('TEST-LOGS','test-stop');await stream;assert.equal(logSignal.aborted,true);}
 finally{controller.abort();await stream;await manager.dispose();}
});

test('a disconnected viewer retires automatically without invalidating another live viewer',async()=>{
 const connections=[];
 const backend={kind:'test',hdcPath:'test',listDevices:async()=>[{serial:'TEST-VIEWERS',state:'online',capabilities:{}}],
  displayGeometry:async()=>({nativeWidth:100,nativeHeight:200,displayId:'0',displayRotation:0}),
  openVideoStream:async()=>{let finish,live=true;const finished=new Promise(resolve=>{finish=resolve;});
   const config=Buffer.alloc(21);config.writeUInt32BE(2);config.writeUInt32BE(13,4);config[8]=2;config.writeUInt32BE(100,9);config.writeUInt32BE(200,13);
   const picture=Buffer.alloc(18);picture.writeUInt32BE(3);picture.writeUInt32BE(10,4);picture[8]=1;
   const connection={finished,changeDriven:true,isLive:()=>live,stream:new ReadableStream({start(c){c.enqueue(config);c.enqueue(picture);}}),
    close:async()=>{live=false;finish();},disconnect:()=>{live=false;finish();}};connections.push(connection);return connection;},dispose:async()=>{}};
 const manager=new HarmonyDeviceManager({backend});
 const [a,b]=await Promise.all([manager.openVideoStream({serial:'TEST-VIEWERS'}),manager.openVideoStream({serial:'TEST-VIEWERS'})]);
 const ar=a.stream.getReader(),br=b.stream.getReader();
 try{await ar.read();await ar.read();await br.read();await br.read();connections[0].disconnect();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.isLive(),false);assert.equal(b.isLive(),true);assert.equal((await manager.getFrameGeometry('TEST-VIEWERS','video')).frameWidth,100);
  connections[1].disconnect();await new Promise(resolve=>setImmediate(resolve));await assert.rejects(manager.getFrameGeometry('TEST-VIEWERS','video'),e=>e.code==='STALE_SNAPSHOT');}
 finally{await ar.cancel();await br.cancel();await a.close();await b.close();await manager.dispose();}
});
