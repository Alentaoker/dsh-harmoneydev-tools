import test from 'node:test';
import assert from 'node:assert/strict';
import {retireLegacyLogTabs} from '../src/legacy-tabs.mjs';
test('migration closes only legacy tabs in the given session',()=>{
 const closed=[];const sidebar={tabsIn:id=>{assert.equal(id,'A');return [{id:'old',kind:'dshE2E'},{id:'video',kind:'dshHarmony'},{id:'logs',kind:'dshLogAnalysis'}];},closeIn:(...args)=>closed.push(args)};
 retireLegacyLogTabs(sidebar,'A');assert.deepEqual(closed,[['A','old']]);
});
test('migration tolerates older hosts and sessions not yet adopted',()=>{
 retireLegacyLogTabs({},'A');retireLegacyLogTabs(null,'A');retireLegacyLogTabs({tabsIn:()=>[],closeIn:()=>assert.fail()},'A');
});

test('migration tolerates a mutable host list and isolated host failures',()=>{const tabs=[{id:'a',kind:'dshE2E'},{id:'b',kind:'dshE2E'}],closed=[];retireLegacyLogTabs({tabsIn:()=>tabs,closeIn:(_s,id)=>{closed.push(id);tabs.shift();if(id==='a')throw Error('host');}},'A');assert.deepEqual(closed,['a','b']);assert.doesNotThrow(()=>retireLegacyLogTabs({tabsIn:()=>{throw Error('host');},closeIn(){}},'A'));});
