import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createLogLibrary } from '../src/log-library.mjs';
async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'dsh-session-search-')), library=createLogLibrary(root);
  try { await run(library); } finally { await library.dispose();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.startsWith(join(tmpdir(),'dsh-session-search-')));await rm(root,{recursive:true,force:true}); }
}
async function upload(library,sessionId,name,text) {
  const scope={sessionId},bytes=Buffer.from(text),file=await library.begin({name,size:bytes.length},scope);
  await library.chunk(file.id,0,bytes,scope);return library.finish(file.id,scope);
}
test('session-wide search scans bodies across files, preserves original lines and does not leak another session',()=>fixture(async library=>{
  const first=await upload(library,'A','one.log','normal\n\nTARGET one\nTARGET two\n');
  await upload(library,'A','two.log','TARGET three\nno\n');await upload(library,'B','secret.log','TARGET secret\n');
  const result=await library.search({query:'target',limit:100},{sessionId:'A'});
  assert.equal(result.filteredTotal,3);assert.equal(result.matchedFiles,2);assert.equal(result.searchedFiles,2);assert.equal(result.sessionId,'A');
  assert.deepEqual(result.entries.filter(row=>row.fileId===first.id).map(row=>row.sourceLine),[3,4]);
  assert.ok(result.entries.every(row=>row.fileName!=='secret.log'));assert.equal(result.nextOffset,null);
  assert.equal((await library.search({query:'target',caseSensitive:true},{sessionId:'A'})).filteredTotal,0);
}));
test('pagination crosses file boundaries without duplicates or omissions and excludes recycled files',()=>fixture(async library=>{
  const one=await upload(library,'A','a.log',Array.from({length:6},(_,i)=>'MATCH '+i).join('\n'));
  await upload(library,'A','b.log',Array.from({length:7},(_,i)=>'MATCH B'+i).join('\n'));
  const keys=[];let offset=0;
  do { const page=await library.search({query:'MATCH',offset,limit:4},{sessionId:'A'});assert.equal(page.filteredTotal,13);keys.push(...page.entries.map(row=>row.fileId+':'+row.sourceLine));offset=page.nextOffset; } while(offset!==null);
  assert.equal(keys.length,13);assert.equal(new Set(keys).size,13);
  await library.remove({ids:[one.id]},{sessionId:'A'});assert.equal((await library.search({query:'MATCH'},{sessionId:'A'})).filteredTotal,7);
}));
test('validates bounded regex and required scope, and honors cancellation',()=>fixture(async library=>{
  await upload(library,'A','a.log','ERROR 42\nWARN 7\n');
  await assert.rejects(library.search({query:'(a+)+',regex:true},{sessionId:'A'}),/分组/);
  assert.equal((await library.search({query:'ERROR [0-9]+$',regex:true},{sessionId:'A'})).filteredTotal,1);
  await assert.rejects(library.search({query:'x'},{}),/会话/);await assert.rejects(library.search({query:' '},{sessionId:'A'}),/关键词/);
  const controller=new AbortController();controller.abort(Error('cancelled'));
  await assert.rejects(library.search({query:'ERROR'},{sessionId:'A'},controller.signal),/cancelled/);
}));
