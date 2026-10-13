import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const output=new URL('./.log-workbench-test.mjs',import.meta.url);
await build({entryPoints:['vendor/lib/harmony/log-filter.ts'],bundle:true,format:'esm',platform:'node',outfile:fileURLToPath(output)});
const {createLogMatcher,createLogTimeRange,logHighlightParts}=await import(output.href);
test.after(()=>rm(output,{force:true}));
const bufferOutput=new URL('./.log-buffer-test.mjs',import.meta.url);
await build({entryPoints:['vendor/lib/harmony/log-buffer.ts'],bundle:true,format:'esm',platform:'node',outfile:fileURLToPath(bufferOutput)});
const {retainLogBatch}=await import(bufferOutput.href);
test.after(()=>rm(bufferOutput,{force:true}));
const appOutput=new URL('./.log-app-test.mjs',import.meta.url);
await build({entryPoints:['vendor/lib/harmony/log-application.ts'],bundle:true,format:'esm',platform:'node',outfile:fileURLToPath(appOutput)});
const {logApplicationPids,logBelongsToApplication}=await import(appOutput.href);
test.after(()=>rm(appOutput,{force:true}));
test('application filtering uses explicit identity, multiprocess PID mapping and refreshed PIDs',()=>{
 const processes=[{pid:10,name:'com.example.app'},{pid:11,name:'com.example.app:worker'},{pid:12,name:'com.example.apple'},{pid:13,name:'custom.process'}];
 const pids=logApplicationPids(processes,'com.example.app','custom.process');assert.deepEqual([...pids],[10,11,13]);
 assert.equal(logBelongsToApplication({pid:12},'com.example.app',pids),false);
 assert.equal(logBelongsToApplication({pid:11},'com.example.app',pids),true);
 assert.equal(logBelongsToApplication({domain:'C04707/com.example.app:worker',tag:'Network'},'com.example.app',new Set()),true);
 assert.equal(logBelongsToApplication({domain:'C04707/com.example.apple',tag:'Network'},'com.example.app',new Set()),false);
 assert.deepEqual([...logApplicationPids([{pid:20,name:'com.example.app'}],'com.example.app')],[20]);
 assert.equal(logBelongsToApplication({pid:10},'com.example.app',logApplicationPids([{pid:20,name:'com.example.app'}],'com.example.app')),false);
 assert.equal(logBelongsToApplication({domain:'C04707',tag:'UI'},'',new Set()),true);
});
test('keyword, regex and case sensitivity keep filter/find semantics explicit',()=>{
 assert.equal(createLogMatcher('error|warn',true).matches('some WARN item'),true);
 assert.equal(createLogMatcher('WARN',false,true).matches('warn'),false);
 assert.equal(createLogMatcher('^UI[0-9]+$',true).matches('UI42'),true);
 assert.ok(createLogMatcher('[',true).error);
 for(const unsafe of ['(a+)+$','a+a+a','a+X','a{1,99}a{1,99}','(x)\\1'])assert.ok(createLogMatcher(unsafe,true).error,unsafe);
 assert.equal(createLogMatcher('^.*error',true).matches('prefix error message'),true);
});
test('find highlights literal special characters and safely handles empty matches',()=>{
 assert.deepEqual(logHighlightParts('a.b aXb','a.b').filter(p=>p.match).map(p=>p.text),['a.b']);
 assert.deepEqual(logHighlightParts('Error error','error',false,true).filter(p=>p.match).map(p=>p.text),['error']);
 assert.deepEqual(logHighlightParts('body','^',true),[{text:'body',match:false}]);
});
test('time range supports HiLog dates and overnight interval',()=>{
 assert.equal(createLogTimeRange('23:59','00:01').matches('10-14 00:00:12.345'),true);
 assert.equal(createLogTimeRange('10-14 01:00','10-14 02:00').matches('10-14 01:30:00.000'),true);
 assert.equal(createLogTimeRange('99:00','').error,'format');
});
test('high-volume batches bound retained rows and text payload together',()=>{
 let entries=[];
 for(let batch=0;batch<100;batch++)entries=retainLogBatch(entries,Array.from({length:1000},(_,i)=>({id:batch*1000+i,raw:'x'.repeat(512),message:'x'.repeat(512)}))).entries;
 assert.ok(entries.length<=10000);
 assert.ok(entries.reduce((n,e)=>n+2*(e.raw.length+e.message.length),0)<=8*1024*1024);
 assert.equal(entries.at(-1).id,99999);
 assert.ok(retainLogBatch([], [{id:1,raw:'x'.repeat(100),message:'large'}],100,10).removed===1);
});
