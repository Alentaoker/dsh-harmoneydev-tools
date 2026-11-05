import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['vendor/lib/harmony/media/recording-preview.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {prepareRecordingPreview,RECORDING_BLOB_LIMIT}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
test('small recordings use normal high-priority fetch and return a revocable exact-byte blob',async()=>{
 const previous=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Length':'3'}});};
 try{const result=await prepareRecordingPreview('/recording',3,new AbortController().signal);assert.equal(calls.length,1);assert.equal(calls[0].options.priority,'high');assert.match(result.url,/^blob:/);assert.deepEqual(new Uint8Array(await(await previous(result.url)).arrayBuffer()),new Uint8Array([1,2,3]));result.dispose();result.dispose();await assert.rejects(previous(result.url));}finally{globalThis.fetch=previous;}
});
test('large or unknown sizes retain direct range playback without downloading a blob',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=()=>assert.fail('must not buffer a large recording');try{for(const size of [RECORDING_BLOB_LIMIT+1,0,NaN]){const result=await prepareRecordingPreview('/recording',size,new AbortController().signal);assert.equal(result.url,'/recording');result.dispose();}}finally{globalThis.fetch=previous;}
});
test('oversized real response length cancels transfer and falls back to range playback',async()=>{
 const previous=globalThis.fetch;let cancelled=false;globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Length':String(RECORDING_BLOB_LIMIT+1)}});try{const result=await prepareRecordingPreview('/recording',3,new AbortController().signal);assert.equal(result.url,'/recording');assert.equal(cancelled,true);}finally{globalThis.fetch=previous;}
});
test('a missing length cannot bypass the byte budget; an aborted view creates no blob',async()=>{
 const previous=globalThis.fetch;let cancelled=false;globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(RECORDING_BLOB_LIMIT+1));},cancel(){cancelled=true;}}));try{const result=await prepareRecordingPreview('/recording',3,new AbortController().signal);assert.equal(result.url,'/recording');assert.equal(cancelled,true);const controller=new AbortController();controller.abort();globalThis.fetch=async()=>new Response(new Uint8Array([1]));await assert.rejects(prepareRecordingPreview('/recording',1,controller.signal),{name:'AbortError'});}finally{globalThis.fetch=previous;}
});
