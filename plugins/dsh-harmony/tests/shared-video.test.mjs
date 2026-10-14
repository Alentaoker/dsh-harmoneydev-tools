import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

const modulePath = resolve('tests/.shared-video-test.mjs');
await build({entryPoints:['vendor/lib/harmony/shared-video.ts'], bundle:true, format:'esm', platform:'node', packages:'external', outfile:modulePath});
const {openSharedVideo, sharedVideoStreaming} = await import('./.shared-video-test.mjs');
const errorBuild=await build({entryPoints:['vendor/lib/harmony/errors.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {HarmonyError}=await import('data:text/javascript;base64,'+Buffer.from(errorBuild.outputFiles[0].contents).toString('base64'));
after(() => rm(modulePath, {force:true}));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(() => reject(new Error('test timeout')), ms);})]); }
  finally { clearTimeout(timer); }
}
function packet(type, key = false, length = 16) {
  const bytes=Buffer.alloc(type === 2 ? 21 : 17+length);
  bytes.writeUInt32BE(type); bytes.writeUInt32BE(bytes.length-8,4);
  bytes[8]=type===2 ? 0 : Number(key); return bytes;
}
function packetReader(connection) {
  const reader=connection.stream.getReader(); let bytes=Buffer.alloc(0);
  return {reader, async next() {
    while(bytes.length<8 || bytes.length<8+bytes.readUInt32BE(4)) {
      const next=await reader.read(); if(next.done) throw new Error('stream ended');
      bytes=Buffer.concat([bytes,next.value]);
    }
    const size=8+bytes.readUInt32BE(4), result=bytes.subarray(0,size); bytes=bytes.subarray(size); return result;
  }};
}
async function fixture(t, limits={}) {
  const directory=await mkdtemp(join(tmpdir(),'dsh-video-share-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const serial='shared-'+createHash('sha256').update(directory).digest('hex').slice(0,12);
  let controller, starts=0, closes=0, sourceSignal;
  const options={serial,directory,idleMs:20,...limits, openSource:async signal=>{
    starts++; sourceSignal=signal;
    const stream=new ReadableStream({start(c){controller=c;}});
    controller.enqueue(packet(2));controller.enqueue(packet(3,true));
    return {stream,changeDriven:true,close:async()=>{closes++;try{controller.close();}catch{}}};
  }};
  const open=overrides=>openSharedVideo({...options,...overrides});
  return {options,open,get starts(){return starts;},get closes(){return closes;},get signal(){return sourceSignal;},
    push:bytes=>controller.enqueue(bytes),fail:error=>controller.error(error),
    record:async()=>JSON.parse(await readFile(join(directory,createHash('sha256').update(serial).digest('hex')+'.broker.json'),'utf8'))};
}
test('concurrent viewers open one encoder; closing one leaves the other live; the last waits for cleanup',async t=>{
  const f=await fixture(t), [a,b]=await Promise.all([f.open(),f.open()]);
  const ar=packetReader(a),br=packetReader(b);
  assert.equal(f.starts,1); assert.equal(sharedVideoStreaming(f.options.serial),true);
  assert.deepEqual(await bounded(ar.next()),packet(2));assert.deepEqual(await bounded(br.next()),packet(2));
  await ar.next();await br.next();await a.close();
  assert.equal(f.closes,0);assert.equal(f.signal.aborted,false);assert.equal(b.isLive(),true);
  f.push(packet(3));assert.deepEqual(await bounded(br.next()),packet(3));
  await b.close();assert.equal(f.closes,1);assert.equal(sharedVideoStreaming(f.options.serial),false);
  await assert.rejects(f.record(),{code:'ENOENT'});
});
test('late viewers replay configuration and the entire current GOP on a static screen',async t=>{
  const f=await fixture(t),a=await f.open(),ar=packetReader(a);
  await ar.next();await ar.next(); f.push(packet(3,false,21));await ar.next();
  const b=await f.open(),br=packetReader(b);
  assert.deepEqual(await bounded(br.next()),packet(2));assert.deepEqual(await bounded(br.next()),packet(3,true));
  assert.deepEqual(await bounded(br.next()),packet(3,false,21));
  assert.equal(f.starts,1);await a.close();await b.close();
});
test('aborting the opening viewer during startup does not abort another waiting subscriber',async t=>{
  const f=await fixture(t),abort=new AbortController();let release;
  const original=f.options.openSource;
  f.options.openSource=async signal=>{await new Promise(resolve=>{release=resolve;});return original(signal);};
  const a=f.open({signal:abort.signal});const rejected=assert.rejects(a,e=>e.code==='COMMAND_ABORTED');
  const bPromise=f.open();
  while(!release) await pause(5);
  await pause(30);abort.abort();await rejected;release();
  const b=await bounded(bPromise);assert.equal(f.starts,1);assert.equal(f.signal.aborted,false);
  const br=packetReader(b);await br.next();await br.next();await b.close();assert.equal(f.closes,1);
});
test('config changes and overflowing replay never give a late viewer an undecodable partial GOP',async t=>{
  const f=await fixture(t,{replayBytes:100}),a=await f.open(),ar=packetReader(a);
  await ar.next();await ar.next();f.push(packet(3,false,128));await ar.next();
  const b=await f.open(),br=packetReader(b);let received=false;
  const pending=br.next().then(value=>{received=true;return value;});await pause(30);assert.equal(received,false);
  const config=packet(2);config[9]=1;f.push(config);f.push(packet(3,false));
  await pause(20);assert.equal(received,false);
  f.push(packet(3,true));assert.deepEqual(await bounded(pending),config);
  assert.deepEqual(await bounded(br.next()),packet(3,true));await a.close();await b.close();
});
test('a slow viewer is disconnected at a bounded queue while the healthy viewer keeps decoding',async t=>{
  const f=await fixture(t,{peerQueueBytes:128*1024}),fast=await f.open(),slow=await f.open(),reader=packetReader(fast);
  await reader.next();await reader.next();
  for(let i=0;i<200&&slow.isLive();i++) {f.push(packet(3,false,64*1024));await bounded(reader.next());}
  // The client may have its TCP read paused; drain until it observes the server's close.
  const sr=slow.stream.getReader();
  await bounded((async()=>{try{while(!(await sr.read()).done){}}catch{}})(),10000);
  assert.equal(slow.isLive(),false);assert.equal(fast.isLive(),true);assert.equal(f.closes,0);
  f.push(packet(3,false,9));assert.deepEqual(await bounded(reader.next()),packet(3,false,9));await fast.close();
});
test('source failure reaches every viewer and a subsequent subscription starts a fresh source',async t=>{
  const f=await fixture(t),[a,b]=await Promise.all([f.open(),f.open()]);
  const ar=packetReader(a),br=packetReader(b);await ar.next();await ar.next();await br.next();await br.next();
  const failures=Promise.all([assert.rejects(ar.next()),assert.rejects(br.next())]);
  f.fail(new Error('source lost'));await bounded(failures);await pause(30);
  const c=await bounded(f.open());assert.equal(f.starts,2);await c.close();assert.equal(f.closes,2);
});
test('a second host process shares the source and may remain watching after the opening viewer closes',async t=>{
  const f=await fixture(t),a=await f.open();
  const worker=join(f.options.directory,'subscriber.mjs');
  await writeFile(worker,`import {openSharedVideo} from ${JSON.stringify(new URL('file:///'+modulePath.replaceAll('\\','/')).href)};
const c=await openSharedVideo({serial:${JSON.stringify(f.options.serial)},directory:${JSON.stringify(f.options.directory)},openSource:async()=>{throw new Error('must share, not start');}});
process.stdout.write('ready\\n');process.stdin.once('data',async()=>{await c.close();process.stdout.write('closed\\n');process.stdin.destroy();});`);
  const child=spawn(process.execPath,[worker],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());
  let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;});
  const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)));
  const ready=new Promise((resolve,reject)=>{child.stdout.on('data',bytes=>{if(bytes.toString().includes('ready'))resolve();});child.once('exit',()=>reject(new Error(stderr||'child exited before ready')));});
  await bounded(ready);assert.equal(f.starts,1);await a.close();assert.equal(f.closes,0);
  child.stdin.write('close\n');assert.equal(await bounded(exited),0,stderr);assert.equal(f.closes,1);
});
test('unauthenticated loopback connections cannot attach to or stop a shared source',async t=>{
  const f=await fixture(t),a=await f.open(),record=await f.record();
  const socket=createConnection(record.port,'127.0.0.1');const closed=new Promise(resolve=>socket.once('close',resolve));
  socket.on('error',()=>{});socket.on('data',()=>{});socket.on('connect',()=>socket.write(JSON.stringify({token:'wrong',op:'close'})+'\n'));
  await bounded(closed);assert.equal(a.isLive(),true);assert.equal(f.closes,0);await a.close();
});

test('source rejection retains contention metadata for every subscriber and permits recovery',async t=>{
 const f=await fixture(t);const original=f.options.openSource;
 f.options.openSource=async()=>{await pause(20);throw new HarmonyError('DEVICE_BUSY','DevEco projection busy',
  {retryable:true,details:{reason:'native-video-conflict',source:'deveco',devicePid:51811,token:'never-relay',privatePath:'never-relay'}});};
 const rejected=await Promise.allSettled([f.open(),f.open()]);
 for(const result of rejected){assert.equal(result.status,'rejected');const e=result.reason;
  assert.equal(e.code,'DEVICE_BUSY');assert.equal(e.retryable,true);
  assert.deepEqual(e.details,{reason:'native-video-conflict',source:'deveco',devicePid:51811});
 }
 await pause(40);f.options.openSource=original;const c=await bounded(f.open());assert.equal(f.starts,1);await c.close();
});

test('a refused cross-process listener waits for normal record retirement instead of spawning a second source',async t=>{
 const f=await fixture(t),server=createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 await new Promise(resolve=>server.close(resolve));
 const path=join(f.options.directory,createHash('sha256').update(f.options.serial).digest('hex')+'.broker.json');
 await writeFile(path,JSON.stringify({version:1,pid:process.pid,nonce:randomUUID(),port,token:'a'.repeat(64)}));
 const opening=f.open();await pause(140);assert.equal(f.starts,0);
 await rm(path);const c=await bounded(opening);assert.equal(f.starts,1);await c.close();
});
