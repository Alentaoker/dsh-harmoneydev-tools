import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
const url=new URL(`./.video-automation-${process.pid}.mjs`,import.meta.url);
const output=await build({stdin:{contents:"export {HybridHarmonyBackend} from './vendor/lib/harmony/hybrid-backend';export {HypiumAutomationDriver} from './vendor/lib/harmony/hypium-backend';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'node',packages:'external',write:false,alias:{'@earendil-works/pi-ai':path.resolve('src/pi-ai.ts'),'@earendil-works/pi-coding-agent':path.resolve('src/pi-sdk.ts')}});
await writeFile(url,output.outputFiles[0].contents);const {HybridHarmonyBackend,HypiumAutomationDriver}=await import(url.href);test.after(()=>unlink(url));
test('cross-profile video keeps pointer input on HDC and forbids UI agent initialization for text and semantics',async()=>{
 const calls=[];
 const hdc={hdcPath:'hdc',nativeVideoStreaming:()=>false,nativeVideoPresent:async()=>true,tap:async()=>calls.push('hdc-tap'),pressKey:async()=>calls.push('hdc-key')};
 const unavailable=()=>Object.assign(new Error('Existing agent required'),{code:'AUTOMATION_DRIVER_UNAVAILABLE',details:{dispatchState:'not-sent'}});
 const driver={execute:async(s,op,args,signal,connect)=>{assert.equal(connect,false);calls.push(op);return {used:false};},semanticAction:async(s,r,signal,connect)=>{assert.equal(connect,false);throw unavailable();},waitForIdle:async(s,i,t,signal,connect)=>{assert.equal(connect,false);return false;}};
 const backend=new HybridHarmonyBackend({hdcBackend:hdc,hypiumDriver:driver});
 await backend.tap('test-cross-video',1,2);await backend.pressKey('test-cross-video','home');
 await assert.rejects(backend.inputText('test-cross-video','text'),/semantic readback/);
 await assert.rejects(backend.semanticAction('test-cross-video',{action:'tap',selector:{text:'entry'}}),/Existing agent/);
 // Keep the timer alive because the production bounded-delay timer is unref'd.
 const keep=setInterval(()=>{},100);try{assert.equal((await backend.waitForIdle('test-cross-video',50,200)).strategy,'bounded_delay');}finally{clearInterval(keep);}
 assert.deepEqual(calls,['hdc-tap','hdc-key','input_text']);
});
test('guarded Hypium calls cannot initialize a cold agent, but reuse a prepared one',async()=>{
 let connects=0,clicks=0;
 const driver={waitForIdle:async()=>{},click:async()=>{clicks++;},disconnect:async()=>{}};
 const backend=new HypiumAutomationDriver({hdcPath:'hdc',preparePrivacy:()=>{},importDriver:async()=>({UiDriver:{connect:async()=>{connects++;return driver;}}})});
 assert.deepEqual(await backend.execute('test-prepared','tap',[1,2],undefined,false),{used:false});assert.equal(connects,0);
 assert.equal(await backend.waitForIdle('test-prepared',100,2000),true);assert.equal(connects,1);
 assert.equal((await backend.execute('test-prepared','tap',[1,2],undefined,false)).used,true);assert.equal(clicks,1);assert.equal(connects,1);
 await backend.reset();assert.deepEqual(await backend.execute('test-prepared','tap',[1,2],undefined,false),{used:false});assert.equal(connects,1);
});

test('a failed UI warmup is retired and does not prevent opening passive video',async()=>{
 let retired=false;
 const hdc={hdcPath:'hdc',openVideoStream:async(_s,_signal,prepare)=>{assert.equal(await prepare(),false);assert.equal(retired,true);return {stream:new ReadableStream(),close:async()=>{}};}};
 const backend=new HybridHarmonyBackend({hdcBackend:hdc,hypiumDriver:{waitForIdle:async()=>{throw Error('UI agent unavailable');},reset:async()=>{retired=true;}}});
 const c=await backend.openVideoStream('test-view-only');await c.close();
});
