import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const temp=await mkdtemp(join(tmpdir(),'dsh-media-contract-'));
await build({entryPoints:['src/media-session.ts'],bundle:true,platform:'node',format:'esm',external:['react'],outfile:join(temp,'session.mjs')});
// Resolve React from this package, not the temporary output directory.
const source=await readFile(join(temp,'session.mjs'),'utf8');
const reactPath=pathToFileURL(join(process.cwd(),'node_modules/react/index.js')).href;
const {writeFile}=await import('node:fs/promises');await writeFile(join(temp,'session.mjs'),source.replaceAll('from "react"',`from ${JSON.stringify(reactPath)}`));
const {prepareMediaAttachment}=await import(pathToFileURL(join(temp,'session.mjs')));
test.after(()=>rm(temp,{recursive:true,force:true}));
function fixture(){const attached=[],state={draft:'原有问题',phase:'plain',occurrences:[{label:'已有引用'}],attachmentIds:['existing']};let alive=true,accepted=true,released=0;
const input={state:{getSnapshot:()=>state},addAttachments:ids=>{if(!accepted)return false;attached.push(...ids);return true;},focus(){},setDraft(){throw Error('Must preserve the draft');}};
const ctx={sessions:{scope:id=>alive?{id}:undefined},conversation:{input:{for:()=>input},createDrafts:(id,files)=>files.map(file=>({id:'new-image',file,session:id})),releaseDraftAttachments:()=>released++}};
return{ctx,state,attached,setAlive:v=>alive=v,setAccepted:v=>accepted=v,released:()=>released};}
test('image attachment preserves text, reference chips and existing attachments; binds destination at invocation',async()=>{const f=fixture(),attach=prepareMediaAttachment(f.ctx,'A');await attach(new File(['png-bytes'],'annotated.png',{type:'image/png'}));assert.deepEqual(f.attached,['new-image']);assert.equal(f.state.draft,'原有问题');assert.equal(f.state.attachmentIds[0],'existing');});
test('busy composer and retired destination refuse images; failed admission releases drafts',async()=>{const f=fixture(),attach=prepareMediaAttachment(f.ctx,'A'),file=new File(['png'],'a.png',{type:'image/png'});f.state.phase='submitting';await assert.rejects(attach(file),/正在/);f.state.phase='plain';f.setAccepted(false);await assert.rejects(attach(file),/未加入/);assert.equal(f.released(),1);f.setAlive(false);await assert.rejects(attach(file),/关闭/);});
test('older hosts fail explicitly instead of replacing text with a file path',()=>{const f=fixture();delete f.ctx.conversation.createDrafts;assert.throws(()=>prepareMediaAttachment(f.ctx,'A'),/配套 DSH/);});

await build({entryPoints:['vendor/lib/harmony/artifacts.ts','vendor/lib/harmony/media-history.ts'],bundle:true,platform:'node',format:'esm',outdir:join(temp,'artifacts')});
const {saveHarmonyScreenshot,markMediaOrigin}=await import(pathToFileURL(join(temp,'artifacts/artifacts.js'))),{listHarmonyMediaHistory}=await import(pathToFileURL(join(temp,'artifacts/media-history.js')));
test('manual media is device-wide across sessions and excludes automation; unknown old files are not reclassified',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-origin-')),config={storage:{screenshotDirectory:join(dir,'screenshots'),recordingDirectory:join(dir,'recordings')}};
  try{const png=Buffer.alloc(64);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);
    const auto=await saveHarmonyScreenshot(config,'DEVICE',{data:png,width:1,height:1});const manual=await saveHarmonyScreenshot(config,'DEVICE',{data:png,width:1,height:1});await markMediaOrigin(manual,'manual');
    assert.equal((await listHarmonyMediaHistory(config,'DEVICE','manual')).artifacts.length,1);
    assert.equal((await listHarmonyMediaHistory(config,'DEVICE','all')).artifacts.length,2);
    await rm(auto.path+'.origin.json');const legacy=await listHarmonyMediaHistory(config,'DEVICE','legacy');assert.equal(legacy.artifacts.length,1);assert.equal(legacy.artifacts[0].source,'unknown');assert.equal(legacy.artifacts[0].filename,auto.filename);
  }finally{await rm(dir,{recursive:true,force:true});}
});
