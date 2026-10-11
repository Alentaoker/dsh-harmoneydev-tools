import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
const moduleUrl = new URL(`./.phone-test-${process.pid}.mjs`, import.meta.url);
const output = await build({entryPoints:['vendor/lib/harmony/hypium-backend.ts'],bundle:true,format:'esm',platform:'node',packages:'external',write:false});
await writeFile(moduleUrl,output.outputFiles[0].contents);
const {resolveFocusedEditable} = await import(moduleUrl.href);
test.after(()=>unlink(moduleUrl));
const node = (type,id) => ({getType:async()=>type,getId:async()=>id,getBounds:async()=>({left:1,top:2,right:3,bottom:4}),exist:async()=>true});
const module = {MatchPattern:{EQUALS:0},BY:{focused:()=>({...by(),onlyFocused:true}),type:()=>by(),id:()=>by()}};
const by = () => ({type:()=>by(),id:()=>by(),focused:()=>by(),within:()=>by()});
const driver = (focused,children=[]) => ({findComponent:()=>children[0]??{exist:async()=>false},findComponents:async q=>q.onlyFocused?focused:children});
test('focused ancestors do not create ambiguous input targets',async()=>{
 const input=node('TextInput','actual-input');
 assert.equal(await resolveFocusedEditable(driver([node('root',''),node('Column','layout'),input]),module),input);
});
test('Search wrapper resolves its editable child even when child is not focused',async()=>{
 const child=node('SearchField','field'),search=node('Search','search');
 assert.equal(await resolveFocusedEditable(driver([node('Navigation',''),search],[child]),module),child);
});
test('two different focused inputs remain ambiguous; no arbitrary first match is used',async()=>{
 await assert.rejects(resolveFocusedEditable(driver([node('TextInput','a'),node('TextInput','b')]),module),e=>e.code==='UI_TARGET_AMBIGUOUS');
 await assert.rejects(resolveFocusedEditable(driver([node('Column','layout')]),module),e=>e.code==='UI_TARGET_NOT_FOUND');
});
