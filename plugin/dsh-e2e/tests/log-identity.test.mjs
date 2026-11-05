import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createLogService,LEGACY_STORAGE_DIR} from '../src/service.mjs';
import {registerRoutes} from '../src/index.mjs';
import {redactLog} from '../src/logs.mjs';

test('package and runtime identity are log-only while existing storage stays in place',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.equal(pkg.name,'dsh-log-analysis');assert.equal(pkg.exports['./agent'],undefined);assert.equal(LEGACY_STORAGE_DIR,'dshE2E');
 const patch=await readFile(new URL('../cordis.patch.yml',import.meta.url),'utf8');assert.match(patch,/name: dsh-log-analysis/);assert.doesNotMatch(patch,/preset-|\/agent/);
 for(const name of ['agent','validation-service','validation-store','capture-session','tool-contract'])await assert.rejects(access(new URL(`../src/${name}.mjs`,import.meta.url)),{code:'ENOENT'});
});
test('actual log routes stream original/downloaded content and never expose validation or old prefix',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-log-identity-'));const service=createLogService({},root),scope={sessionId:'A'};
 try{const bytes=Buffer.from('11-05 03:00:00.001 1 2 E C00001 Demo: error example\n');const upload=await service.logLibrary.begin({name:'real-format.log',size:bytes.length},scope);await service.logLibrary.chunk(upload.id,0,bytes,scope);const file=await service.logLibrary.finish(upload.id,scope);
 const routes=new Map();registerRoutes({effect:fn=>fn(),connection:{fetch:{register:route=>routes.set(route.path,route)}}},service);
 assert.ok([...routes.keys()].every(p=>p.startsWith('/api/dsh-log-analysis/log-library/')));assert.ok(!routes.has('/api/dsh-e2e/status'));assert.ok(!routes.has('/api/dsh-log-analysis/validation/tasks'));
 const request=path=>new Request(`http://localhost/api/dsh-log-analysis/log-library/${path}?sessionId=A&id=${file.id}`);
 const source=await routes.get('/api/dsh-log-analysis/log-library/source').fetch(request('source'));assert.equal(source.status,200);assert.deepEqual(Buffer.from(await source.arrayBuffer()),bytes);
 const exported=await routes.get('/api/dsh-log-analysis/log-library/export').fetch(request('export'));assert.equal(exported.status,200);const lines=(await exported.text()).trim().split('\n');assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).sourceLine,1);
 const capabilities=await routes.get('/api/dsh-log-analysis/log-library/capabilities').fetch(request('capabilities'));assert.equal((await capabilities.json()).plugin,'dshLogAnalysis');
 }finally{await service.dispose();assert.equal(dirname(root),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test('log import and direct deletion leave all old task and attempt data byte-for-byte intact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-log-old-data-'));const service=createLogService({},root);
 try{const protectedFiles=['validation-v1/attempt.json','workflows/old.json','validation-v1/standalone/capture.json'];for(const file of protectedFiles){await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),'OLD DATA '+file);}
 const bytes=Buffer.from('current test log\n'),scope={sessionId:'A'},upload=await service.logLibrary.begin({name:'one.log',size:bytes.length},scope);await service.logLibrary.chunk(upload.id,0,bytes,scope);const file=await service.logLibrary.finish(upload.id,scope);await service.logLibrary.remove({ids:[file.id]},scope);await service.dispose();
 for(const file of protectedFiles)assert.equal(await readFile(join(root,file),'utf8'),'OLD DATA '+file);
 }finally{await service.dispose();assert.equal(dirname(root),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test('retained log redaction removes tokens and explicit secrets without hiding ordinary errors',()=>{const value=redactLog('Bearer secret-value password=private-token error: timeout custom-private',['custom-private']);assert.doesNotMatch(value,/secret-value|private-token|custom-private/);assert.match(value,/error: timeout/);});
