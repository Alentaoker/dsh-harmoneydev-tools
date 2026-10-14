import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createRecordStore, paginate } from '../src/records.mjs';
import { createService } from '../src/service.mjs';
import { requestScope, mutationBody, registerRoutes } from '../src/index.mjs';
import { reportView, failureCategory } from '../src/presentation.mjs';
import { maskedEvidence } from '../src/evidence.mjs';
const record = (sessionId, status = 'failed') => ({ id: randomUUID(), flowId: 'a'.repeat(24), sessionId, name: '测试记录', status, createdAt: new Date().toISOString(), args: { name: '测试记录', goal: '检查界面', expectation: '界面可见', collectLogs: false } });
test('会话隔离、31 条之后的报告、分类分页和归档保留正文', async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-records-')), store=createRecordStore(root);
  try {
    const records=[];
    for(let i=0;i<42;i++){const r=record(i<35?'first':'second',i%2?'passed':'failed');r.createdAt=new Date(1000+i*1000).toISOString();await store.save(r,{...r,logs:[{message:'正文'}]});records.push(r);}
    const all=await store.all();assert.equal(all.length,42);
    const p=paginate(all,{sessionId:'first',limit:20});assert.equal(p.total,35);assert.equal(p.nextOffset,20);assert.equal(p.runs.some(r=>r.sessionId==='second'),false);
    assert.equal(paginate(all,{sessionId:'first',offset:20}).runs.length,15);
    assert.equal(paginate(all,{sessionId:'second',status:'passed'}).runs.length,4);
    const old=await store.get(records[0].id,{sessionId:'first'});assert.equal(old.logs[0].message,'正文');
    await assert.rejects(store.get(old.id,{sessionId:'second'}),/不属于/);
    const indexText=await readFile(join(old.directory,'record.json'),'utf8');assert.equal(indexText.includes('正文'),false);assert.equal(indexText.includes('args'),false);
    assert.equal(paginate(all,{}).total,0);assert.equal(paginate(all,{sessionId:'second',all:true}).total,42);
    const service=createService({dshHarmony:{automation:{}}},root);
    await service.archive(old.id,true,{sessionId:'first'});assert.equal((await service.listPage({sessionId:'first'})).total,34);assert.equal((await service.listPage({sessionId:'first',archived:true})).total,1);assert.equal((await service.get(old.id,{sessionId:'first'})).logs[0].message,'正文');
    await service.dispose();
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('兼容旧记录；冷启动将未完成任务标成中断；损坏报告不遮挡其他记录',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-legacy-'));
  try {
    const old=record(undefined,'running'),dir=join(root,'workflows',old.flowId,'runs',old.id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'dsh-run.json'),JSON.stringify(old));
    const broken=join(root,'workflows',old.flowId,'runs',randomUUID());await mkdir(broken,{recursive:true});await writeFile(join(broken,'dsh-run.json'),'{bad');
    const store=createRecordStore(root),records=await store.all();assert.equal(records.length,1);assert.equal(records[0].status,'interrupted');assert.equal(records[0].checks.leaseReleased,false);assert.equal(paginate(records,{sessionId:'other'}).total,0);assert.equal(paginate(records,{all:true}).total,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('复测保留原参数、新 ID、关联和修改预算；跨会话拒绝且不操作设备',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-retry-'));let inputs=0;
  const m={listDevices:async()=>{inputs++;throw Error('模拟离线');}};
  const service=createService({dshHarmony:{automation:{getManager:()=>m}}},root);
  try {
    const first=await service.run({goal:'目标',expectation:'原验收',collectLogs:false,steps:[{action:'assert',selector:{kind:'text',value:'设置'}}]},'first',{});
    await assert.rejects(service.retry(first.id,{expectation:'修改验收'},'second',{}),/不属于/);assert.equal(inputs,1);
    await assert.rejects(service.replay(first.id,'first',{}),/仅通过/);assert.equal(inputs,1);
    const retry=await service.retry(first.id,{expectation:'修改验收',maxModelCalls:12},'first',{});assert.notEqual(first.id,retry.id);assert.equal(retry.parentRunId,first.id);assert.equal(retry.relation,'retry');
    assert.equal((await service.get(first.id)).args.expectation,'原验收');assert.equal((await service.get(retry.id)).args.maxModelCalls,12);assert.equal((await service.report(retry.id,{sessionId:'first'})).related[0].id,first.id);
    const planned=await service.retry(first.id,{clearSteps:true,expectation:'新的明确验收'},'first',{});assert.equal((await service.get(planned.id)).args.steps,undefined);assert.equal((await service.get(first.id)).args.steps.length,1);
  }finally{await service.dispose();await rm(root,{recursive:true,force:true});}
});
test('网页所有读取需要会话，全部历史只读不能放宽写入；限制跨站和大请求',async()=>{
  assert.throws(()=>requestScope(new Request('http://localhost/report?id=x')),/会话/);
  const req=new Request('http://localhost/report?sessionId=one&scope=all');assert.equal(requestScope(req).all,true);assert.equal(requestScope(req,true).all,false);
  await assert.rejects(mutationBody(new Request('http://localhost/cancel',{method:'POST',headers:{origin:'https://other.example'},body:'{}'})),/来源/);
  await assert.rejects(mutationBody(new Request('http://localhost/cancel',{method:'POST',body:'a'.repeat(5000)})),/过大/);
});
test('运行器真实嵌套结构归一化，失败分类和缺证据有明确边界',()=>{
  const job={status:'failed',error:'AccountQuotaExceeded 429',args:{goal:'测试'}};
  const report={run:{summary:{failed:1},results:[{attempts:[{artifacts:[{kind:'log',path:'attempt/failure.txt'}],steps:[{id:'a',label:'执行',status:'failed',metrics:{modelCalls:4,actionSteps:2},events:[{kind:'engine',name:'tap',status:'failed'}],error:{message:'控件失效'}}]}]}]}};
  const view=reportView(job,report);assert.equal(view.steps.length,1);assert.equal(view.totals.modelCalls,4);assert.equal(view.files[0].file,'e2e/attempt/failure.txt');assert.equal(view.screenshots.length,0);assert.equal(view.failure.label,'模型服务不可用');assert.equal(view.reportWritten,true);
  assert.equal(reportView(job,undefined).reportWritten,false);assert.equal(failureCategory({status:'failed',error:'已用完调用次数'}).label,'执行预算耗尽');
});
test('截图边界验证并遮挡敏感区域；不完整控件树不写证据',async()=>{
  const data=await sharp({create:{width:100,height:100,channels:3,background:'#ffffff'}}).png().toBuffer();
  const raw={screenshot:{data},quality:{treeStatus:'valid',scopeComplete:true},nodes:[{hint:'密码',bounds:{left:0,top:0,right:50,bottom:50}}]},g={nativeWidth:100,nativeHeight:100};
  const image=await maskedEvidence(raw,g),pixel=await sharp(image).raw().toBuffer();assert.equal(pixel[0],17);
  await assert.rejects(maskedEvidence(raw,{...g,nativeWidth:101}),/不一致/);
  await assert.rejects(maskedEvidence({...raw,quality:{treeStatus:'valid',scopeComplete:false}},g),/完整/);
});
test('确定步骤的 Home 和 tap 也计入动作，不把缺失的 agent metrics 当作零',()=>{
  const view=reportView({status:'passed'},{run:{results:[{attempts:[{steps:[{id:'home',kind:'resource',api:'device.home',status:'passed'},{id:'tap',kind:'locator',api:'locator.tap',events:[{kind:'engine',name:'tap',status:'passed',count:1}]},{id:'assert',kind:'assertion',events:[{kind:'poll',name:'expect',count:3}]}]}]}]}});
  assert.equal(view.totals.actions,2);assert.equal(view.totals.modelCalls,0);assert.equal(failureCategory({status:'running'}),null);
});
test('真实文件路由返回 PNG，报告和文件都检查范围，拒绝路径越界',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-routes-')),store=createRecordStore(root),r=record('one','passed'),service=createService({},root),routes=new Map();
  try {
    await store.save(r,{...r,logs:[]});const dir=store.directory(r),png=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();await writeFile(join(dir,'before.png'),png);
    registerRoutes({effect:fn=>fn(),connection:{fetch:{register:route=>{assert.equal(route.requestBody,'buffered','DSH 的 bodyless GET 不能落入 streaming 分支');routes.set(route.path,route);}}}},service);
    const invoke=(path,query)=>routes.get('/api/dsh-e2e/'+path).fetch(new Request('http://localhost/api/dsh-e2e/'+path+'?id='+r.id+'&'+query));
    const image=await invoke('artifact','sessionId=one&file=before.png');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
    assert.equal((await invoke('artifact','sessionId=two&file=before.png')).status,404);
    assert.equal((await invoke('report','sessionId=two')).status,400);
    assert.equal((await invoke('artifact','sessionId=two&scope=all&file=before.png')).status,200);
    assert.equal((await invoke('artifact','file=before.png')).status,404);
    assert.equal((await invoke('artifact','sessionId=one&file=..%2F..%2Foutside.png')).status,404);
    assert.equal((await invoke('artifact','sessionId=one&file=image.svg')).status,404);
  }finally{await service.dispose();await rm(root,{recursive:true,force:true});}
});
