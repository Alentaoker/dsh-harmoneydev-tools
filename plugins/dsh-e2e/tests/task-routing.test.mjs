import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { apply } from '../src/agent.mjs';
import { createService, validateRun } from '../src/service.mjs';
import { parseDecision } from '../src/executor.mjs';

test('app-name aliases search consistently; operation-specific mistakes fail without starting a run',async()=>{
 let tool,query,dispatches=0;
 apply({effect:fn=>fn(),tools:{register:t=>{tool=t;}},systemPrompt:{section(){}},dshE2E:{resolveApp:async q=>{query=q;return{query:q};},run:async()=>{dispatches++;}}});
 const exec={agent:{id:'unit',options:{}},signal:new AbortController().signal};
 for(const key of ['name','appName','query']){await tool.execute({operation:'resolve_app',[key]:'小艺'},exec);assert.equal(query,'小艺');}
 await assert.rejects(tool.execute({operation:'resolve_app',query:'小艺',name:'Work'},exec),/冲突/);
 await assert.rejects(tool.execute({operation:'run',goal:'测试',expectation:'结果',milliseconds:25000},exec),/milliseconds/);
 assert.equal(dispatches,0);
 assert.throws(()=>validateRun({goal:'当前页',runMode:'verify_current',appBundle:'mock.app',expectation:'可见'}),/只验当前页/);
 assert.throws(()=>validateRun({goal:'当前页',runMode:'verify_current',steps:[{action:'home'}]}),/只验当前页/);
 assert.throws(()=>parseDecision('{"action":"wait","milliseconds":1000}'),/waitMs/);
});

test('current-page visual verification uses pixels, records evidence and never runs the action goal',{timeout:60000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-verify-'));
 const data=await sharp({create:{width:200,height:100,channels:3,background:'#f00'}}).png().toBuffer();
 let actions=0,calls=0,released=0,images=0,geometryCalls=0;
 const m={listDevices:async()=>[{serial:'TEST',state:'online',capabilities:{uiTree:true,tap:true}}],acquireLease:async()=>({token:'test-lease'}),renewLease(){},releaseLease(){released++;return true;},prepareDevice:async()=>{},snapshot:async o=>({generation:1,revision:1,quality:{treeStatus:'valid',scopeComplete:true},nodes:[{ref:'r',type:'Image',id:'result',visible:true,bounds:{left:0,top:0,right:200,bottom:100}}],...(o.includeScreenshot?{screenshot:{data}}:{})}),getDisplayGeometry:async()=>{geometryCalls++;return{nativeWidth:200,nativeHeight:100};},tapRef:async()=>{actions++;},inputText:async()=>{actions++;}};
 const ctx={dshHarmony:{automation:{getManager:()=>m}},attachments:{saveImage:async o=>{images++;assert.ok(o.data.length);return{attachmentId:'visual-input',mediaType:'image/png'};}},llm:{resolveModelInfo:async()=>({inputModalities:['text','image']}),async *stream(o){calls++;assert.ok(o.system.includes('验收员'));assert.equal(o.messages[0].content[1].type,'image');yield{type:'text-delta',text:'{"action":"assert","passed":true,"summary":"真实截图是红色"}'};}}};
 const service=createService(ctx,root);
 try {
  const result=await service.run({goal:'绝不能再次点击发送',expectation:'截图为红色',runMode:'verify_current',verificationMode:'visual',collectLogs:false},'unit',{provider:'mock',model:'vision'},AbortSignal.timeout(50000));
  assert.equal(result.status,'passed',result.error);assert.equal(actions,0);assert.equal(calls,1);assert.equal(images,1);assert.equal(released,1);assert.equal(result.runMode,'verify_current');
  const record=await service.get(result.id);assert.ok(await readFile(join(record.directory,'verification-1.png')));assert.equal(result.verificationEvidence.length,1);assert.ok(result.checks.reportWritten);
  const cold=await service.report(result.id);assert.ok(cold.view.screenshots.some(s=>s.file==='verification-1.png'));
 } finally {await service.dispose();await rm(root,{recursive:true,force:true});}
});

test('text-only model fails visual admission before acquiring control, with a persisted failure record',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-no-vision-'));let acquisitions=0;
 const service=createService({dshHarmony:{automation:{getManager:()=>({listDevices:async()=>[{serial:'TEST',state:'online',capabilities:{uiTree:true,tap:true}}],acquireLease:async()=>{acquisitions++;}})}},llm:{resolveModelInfo:async()=>({inputModalities:['text']})}},root);
 try {const result=await service.run({goal:'看图',expectation:'是猫',verificationMode:'visual',collectLogs:false},'unit',{provider:'mock',model:'text'},AbortSignal.timeout(5000));assert.equal(result.status,'failed');assert.equal(result.errorCode,'VISION_UNAVAILABLE');assert.equal(acquisitions,0);assert.ok((await service.get(result.id)).error.includes('图像'));}
 finally {await service.dispose();await rm(root,{recursive:true,force:true});}
});
