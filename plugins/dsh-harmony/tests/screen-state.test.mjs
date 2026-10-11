import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:['vendor/lib/harmony/observation/screen-state.ts'],format:'esm',bundle:true,write:false});
const {parseScreenState}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
test('AOD is not an interactive awake screen',()=>{
 assert.deepEqual(parseScreenState('* screenState true\n * interactiveState 0\n * screenLocked true'),{awake:false,locked:true});
 assert.deepEqual(parseScreenState('* screenState true\n * interactiveState 2\n * screenLocked false'),{awake:true,locked:false});
});
test('unknown lock state remains unknown instead of assuming unlocked',()=>{
 assert.deepEqual(parseScreenState('service unavailable'),{awake:false,locked:undefined});
});
