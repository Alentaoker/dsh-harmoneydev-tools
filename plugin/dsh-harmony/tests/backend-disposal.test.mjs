import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const output=await build({stdin:{contents:"export {HdcBackend} from './vendor/lib/harmony/hdc-backend';export {openSharedVideo} from './vendor/lib/harmony/shared-video';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'node',packages:'external',write:false,alias:{'@earendil-works/pi-ai':path.resolve('src/pi-ai.ts')}});
const moduleFile=new URL(`./.backend-disposal-${process.pid}.mjs`,import.meta.url);
await writeFile(moduleFile,output.outputFiles[0].contents);
test.after(()=>rm(moduleFile,{force:true}));
const {HdcBackend,openSharedVideo}=await import(moduleFile.href);

test('backend disposal continues recording and temporary-file cleanup after synchronous closer and recording failures',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dsh-disposal-'));let discarded=0,commands=0;
 const backend=new HdcBackend({hdcPath:process.execPath,execute:async()=>{commands++;return {stdout:'',stderr:'',exitCode:0};}});
 backend.videoClosers.add(()=>{throw Error('closer failed');});
 backend.ownedRecordings.set('one',{recording:{discard:async()=>{discarded++;throw Error('recording failed');}}});
 backend.ownedRecordings.set('two',{recording:{discard:async()=>{discarded++;}}});
 backend.liveScreenshotPaths.set('TEST-CLEANUP',{remotePath:'/data/local/tmp/test-cleanup.jpeg',directory});
 try{await assert.rejects(backend.dispose(),error=>error.code==='DEVICE_BUSY');assert.equal(discarded,2);assert.equal(commands,1);assert.equal(backend.ownedRecordings.size,0);assert.equal(backend.liveScreenshotPaths.size,0);await assert.rejects(stat(directory),{code:'ENOENT'});}finally{await rm(directory,{recursive:true,force:true});}
});

test('disposing an unselected backend does not retire another backend video broker',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dsh-candidate-disposal-'));let stopped=0;
 const config=Buffer.alloc(21);config.writeUInt32BE(2);config.writeUInt32BE(13,4);
 const frame=Buffer.alloc(33);frame.writeUInt32BE(3);frame.writeUInt32BE(25,4);frame[8]=1;
 const connection=await openSharedVideo({serial:'CANDIDATE-TEST',directory,openSource:async()=>({stream:new ReadableStream({start(c){c.enqueue(config);c.enqueue(frame);}}),close:async()=>{stopped++;}})});
 try{const backend=new HdcBackend({hdcPath:process.execPath});await backend.dispose();assert.equal(stopped,0);assert.equal(connection.isLive(),true);}finally{await connection.close();assert.equal(stopped,1);await rm(directory,{recursive:true,force:true});}
});
