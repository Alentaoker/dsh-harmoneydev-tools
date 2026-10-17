import './profile-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRoot, createService, validateRun, inside } from '../src/service.mjs';
import { convertSnapshot } from '../src/engine.mjs';
import { parseDecision, harnessExecutor } from '../src/executor.mjs';
import { createServer } from 'node:http';

test('任务必须有验收条件；禁止未知动作和超出目录的报告文件',()=>{
  assert.throws(()=>validateRun({goal:'打开设置'}),/expectation/);
  assert.throws(()=>validateRun({goal:'测试',steps:[{action:'shell'}]}),/不支持/);
  assert.throws(()=>validateRun({goal:'测试',steps:[{action:'home'}]}),/断言/);
  assert.throws(()=>inside('E:/report','../credentials.json'),/超出/);
  assert.throws(()=>parseDecision('{"action":"shell"}'),/支持/);
});
test('鸿蒙节点转换：稳定 ID、失效节点和密码脱敏',()=>{
  const s={generation:1,quality:{appId:'test',treeStatus:'valid',scopeComplete:true},nodes:[{ref:'a',id:'input',type:'TextInput',text:'one',bounds:{left:0,top:0,right:100,bottom:40}},{ref:'b',id:'password',type:'TextInput',text:'private',hint:'密码'}]};
  const first=convertSnapshot(s,{width:100,height:100}); const second=convertSnapshot({...s,nodes:s.nodes.map(n=>({...n,ref:'next-'+n.ref,text:'two'}))},{width:100,height:100});
  assert.equal(first.snapshot.root.children[0].ref.id,second.snapshot.root.children[0].ref.id);
  assert.equal(first.snapshot.root.children[1].text,''); assert.equal(first.snapshot.root.children[1].value,undefined);
  assert.equal(first.snapshot.root.children[1].states.secure,true);
});
test('重复且无进展的模型动作受到硬限制',async()=>{
  const server=createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');res.end(JSON.stringify({text:'{"action":"tap","id":"target"}',provider:'mock',model:'mock'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const priorURL=process.env.DSH_E2E_BRIDGE_URL,priorToken=process.env.DSH_E2E_BRIDGE_TOKEN;process.env.DSH_E2E_BRIDGE_URL=`http://127.0.0.1:${server.address().port}`;process.env.DSH_E2E_BRIDGE_TOKEN='unit-test';
  let taps=0,calls=0;try{const verdict=await harnessExecutor().runStep({step:{kind:'act',instruction:'打开设置'},signal:AbortSignal.timeout(5000),observe:async()=>({text:'#target button 设置'}),actions:{tap:async()=>{taps++}},budgets:{maxActions:8,maxModelCalls:8,actionsUsed:()=>taps,recordModelCall:()=>{calls++}}});assert.equal(verdict.status,'blocked');assert.equal(taps,2);assert.equal(calls,3);}finally{if(priorURL===undefined)delete process.env.DSH_E2E_BRIDGE_URL;else process.env.DSH_E2E_BRIDGE_URL=priorURL;if(priorToken===undefined)delete process.env.DSH_E2E_BRIDGE_TOKEN;else process.env.DSH_E2E_BRIDGE_TOKEN=priorToken;await new Promise(r=>server.close(r));}
});
test('并发任务拒绝且取消后不派发物理输入',async()=>{
  let inputs=0;const service=createService({dshHarmony:{automation:{getManager:()=>({listDevices:async signal=>{signal.throwIfAborted();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},releaseLease(){},pressKey(){inputs++}})}},llm:{}});
  const controller=new AbortController(),args={goal:'取消验收',expectation:'仅测试取消',name:'cancel-'+Date.now()};const first=service.run(args,'unit',{},controller.signal);
  try{await assert.rejects(service.run(args,'unit',{},AbortSignal.timeout(5000)),/已有手机测试/);controller.abort(new Error('取消验收'));assert.equal((await first).status,'cancelled');assert.equal(inputs,0);}finally{await service.dispose();}
});
test('派发前目标离开屏幕时重新观察；不重放未确认动作',async()=>{
  let calls=0,taps=0,inputs=0;
  const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.end(JSON.stringify({text:JSON.stringify(calls===3?{action:'done'}:{action:'tap',id:calls===1?'old':'fresh'}),provider:'mock',model:'mock'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const priorURL=process.env.DSH_E2E_BRIDGE_URL,priorToken=process.env.DSH_E2E_BRIDGE_TOKEN;
  process.env.DSH_E2E_BRIDGE_URL=`http://127.0.0.1:${server.address().port}`;process.env.DSH_E2E_BRIDGE_TOKEN='unit-test';
  try{const result=await harnessExecutor().runStep({step:{kind:'act',instruction:'打开'},signal:AbortSignal.timeout(5000),observe:async()=>({text:calls?'#fresh button':'#old button'}),actions:{tap:async ref=>{taps++;if(ref.id==='old')throw Object.assign(new Error('the target node left the screen before the action reached it'),{code:'LOCATOR_NOT_FOUND'});inputs++;}},budgets:{maxActions:5,maxModelCalls:3,actionsUsed:()=>taps,recordModelCall(){}}});assert.equal(result.status,'passed');assert.equal(inputs,1);assert.equal(calls,3);}
  finally{if(priorURL===undefined)delete process.env.DSH_E2E_BRIDGE_URL;else process.env.DSH_E2E_BRIDGE_URL=priorURL;if(priorToken===undefined)delete process.env.DSH_E2E_BRIDGE_TOKEN;else process.env.DSH_E2E_BRIDGE_TOKEN=priorToken;await new Promise(r=>server.close(r));}
});
test('真实 e2e runner：执行、断言、报告、缓存回放与失败释放控制',{timeout:120000},async()=>{
  let text='',released=0,modelCalls=0,emit,invalidOutput=false;
  const snapshot=()=>({generation:1,quality:{appId:'mock.app',treeStatus:'valid',scopeComplete:true},nodes:[{ref:'input-ref',id:'search',type:'TextInput',text, hint:'搜索',focused:true,clickable:true,enabled:true,visible:true,bounds:{left:10,top:10,right:190,bottom:60}}]});
  const m={async listDevices(){return[{serial:'TEST-PHONE',state:'online',name:'模拟设备',capabilities:{uiTree:true,tap:true}}]},async applications(){return[{bundleName:'mock.app',label:'模拟应用'}]},async acquireLease(){return{token:'private-lease'}},renewLease(){},releaseLease(){released++;return true},async prepareDevice(){},async listProcesses(){return[{pid:61,name:'mock.app'}]},async readLogs(){return[]},async streamLogs(_s,cb,signal){emit=cb;cb([]);await new Promise(r=>signal.addEventListener('abort',r,{once:true}))},async snapshot(){return snapshot()},async getDisplayGeometry(){return{nativeWidth:200,nativeHeight:100}},async getFrameGeometry(){throw Error('Tree-based automation must not depend on a fresh screenshot');},async tapRef(){},async inputText(o){text=o.text;emit([{pid:61,level:'info',tag:'mock',message:'输入完成 token=not-a-secret api_key=sample-secret',raw:'mock input'}]);},async pressKey(){},async stopApp(){},async launchApp(){},async runScenario(){text='';return{status:'passed'}}};
  const ctx={dshHarmony:{automation:{getManager:()=>m}},llm:{async *stream(o){modelCalls++;const prompt=JSON.parse(o.messages[0].content[0].text);let d;if(o.system.includes('验收员'))d={action:'assert',passed:prompt.screen.includes('显示'),summary:'屏幕出现显示'};else if(prompt.screen.includes('value="显示"'))d={action:'done',summary:'已输入显示'};else{const match=prompt.screen.match(/#([\w-]+).*textbox/);d={action:'type',id:match?.[1],text:'显示'}} yield{type:'text-delta',text:invalidOutput?'not-json':JSON.stringify(d)};yield{type:'finish',reason:{kind:'stop'}}}}};
  const service=createService(ctx);const signal=AbortSignal.timeout(100000);const input={goal:'在搜索框输入显示',expectation:'输入框里显示“显示”',name:'integration-'+Date.now(),appBundle:'mock.app',timeoutMs:30000,maxActions:5,maxModelCalls:5};
  try{
    const first=await service.run(input,'test-session',{provider:'mock',model:'mock'},signal);
    const j=await service.get(first.id);const log=await readFile(join(j.directory,'runner.log'),'utf8');
    assert.equal(first.status,'passed',first.error+'\n'+log);assert.equal(first.checks.leaseReleased,true);assert.ok(first.checks.reportWritten);
    assert.equal(first.logCollection.status,'captured');assert.ok(first.diagnostics.entries.length);assert.equal(first.diagnostics.entries[0].message.includes('sample-secret'),false);
    assert.equal((await service.getLogs(first.id)).total,1);assert.ok((await readFile(join(j.directory,'app-logs.jsonl'),'utf8')).includes('输入完成'));
    const calls=modelCalls;text='';
    const second=await service.replay(first.id,'test-session',{provider:'mock',model:'mock'},signal);
    assert.equal(second.status,'passed',await readFile(join((await service.get(second.id)).directory,'runner.log'),'utf8'));
    assert.ok(modelCalls-calls < calls,'回放应减少模型调用');assert.equal(released,2);
    const bad=await service.run({goal:'错误断言',name:'failure-'+Date.now(),logAppBundle:'mock.app',steps:[{action:'assert',selector:{kind:'text',value:'不存在的控件'}}],timeoutMs:20000},'test-session',{},signal);
    assert.equal(bad.status,'failed');assert.equal(bad.checks.leaseReleased,true);assert.equal(released,3);
    invalidOutput=true;
    const invalid=await service.run({...input,name:'invalid-verdict-'+Date.now()},'test-session',{provider:'mock',model:'mock'},signal);
    assert.equal(invalid.status,'failed');assert.match(invalid.error,/模型动作无法解析/);assert.doesNotMatch(invalid.error,/invalid verdict/);assert.equal(invalid.checks.leaseReleased,true);
    assert.equal(JSON.stringify(first).includes('private-lease'),false);
  }finally{await service.dispose();}
});
