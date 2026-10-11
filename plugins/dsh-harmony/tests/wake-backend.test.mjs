import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
const location=new URL(`./.wake-test-${process.pid}.mjs`,import.meta.url);
const output=await build({entryPoints:['vendor/lib/harmony/hdc-backend.ts'],bundle:true,format:'esm',platform:'node',packages:'external',write:false,
 alias:{'@earendil-works/pi-ai':path.resolve('src/pi-ai.ts'),'@earendil-works/pi-coding-agent':path.resolve('src/pi-sdk.ts')}});
await writeFile(location,output.outputFiles[0].contents);
const {HdcBackend}=await import(location.href);
test.after(()=>unlink(location));
function fake(initialAwake,knownLock=true){
 let awake=initialAwake;const commands=[];
 const backend=new HdcBackend({hdcPath:process.execPath,execute:async spec=>{
  commands.push(spec.args);
  if(spec.operation==='wake_device' && spec.args.includes('-d18') && spec.args.includes('-u18')) awake=true;
  const stdout=spec.operation==='screen_state'?`* screenState ${awake}\n * interactiveState ${awake?2:0}\n${knownLock?' * screenLocked false':''}`:spec.operation==='wake_device'?'you raised the key 18':'';
  return {stdout:Buffer.from(stdout),stderr:Buffer.alloc(0),exitCode:0,durationMs:1};
 }});return {backend,commands};
}
test('wake uses valid joined uinput arguments and does not repeat a confirmed key release',async()=>{
 const {backend,commands}=fake(false);await backend.prepareDevice('test-phone');
 assert(commands.some(args=>args.includes('-d18')&&args.includes('-i120')&&args.includes('-u18')));
 assert(!commands.some(args=>args.includes('-u18')&&!args.includes('-d18')));
});
test('preparing an already awake phone is idempotent and unknown lock state sends no input',async()=>{
 const awake=fake(true);await awake.backend.prepareDevice('test-phone');assert(!awake.commands.some(args=>args.includes('uinput')));
 const unknown=fake(false,false);await assert.rejects(unknown.backend.prepareDevice('test-phone'),e=>e.code==='OBSERVATION_UNAVAILABLE');
 assert(!unknown.commands.some(args=>args.includes('uinput')));
});
