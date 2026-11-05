import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';

const output=await build({entryPoints:['vendor/lib/harmony/device-events.ts'],bundle:true,format:'cjs',platform:'browser',write:false});
test('two conversation views share metadata events; only the last release closes the source',()=>{
 const sources=[];
 class Events{constructor(url){this.url=url;this.closes=0;sources.push(this);}close(){this.closes++;}}
 const module={exports:{}};runInNewContext(output.outputFiles[0].text,{module,exports:module.exports,EventSource:Events});
 const {subscribeDeviceEvents}=module.exports,a=[],b=[];
 const stopA=subscribeDeviceEvents(e=>a.push(e.data)),stopB=subscribeDeviceEvents(e=>b.push(e.data));
 assert.equal(sources.length,1);assert.equal(sources[0].url,'/api/harmony/events');sources[0].onmessage({data:'first'});
 assert.deepEqual(a,['first']);assert.deepEqual(b,['first']);stopA();stopA();assert.equal(sources[0].closes,0);
 sources[0].onmessage({data:'second'});assert.deepEqual(a,['first']);assert.deepEqual(b,['first','second']);stopB();assert.equal(sources[0].closes,1);
 const stopC=subscribeDeviceEvents(()=>{});assert.equal(sources.length,2);stopC();assert.equal(sources[1].closes,1);
});
