import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const output='tests/.native-resource-test.mjs';
await build({entryPoints:['vendor/lib/harmony/native-video-resource.ts'],bundle:true,format:'esm',platform:'node',packages:'external',outfile:output});
const {embeddedNativeVideoResource,nativeVideoProfile}=await import('./.native-resource-test.mjs');
await rm(output);
const backendOutput='tests/.retired-hap-test.mjs';
await build({entryPoints:['vendor/lib/harmony/hdc-backend.ts'],bundle:true,format:'esm',platform:'node',packages:'external',outfile:backendOutput,
  alias:{'@earendil-works/pi-ai':resolve('src/pi-ai.ts'),'@earendil-works/pi-coding-agent':resolve('src/pi-sdk.ts')}});
const {HdcBackend}=await import('./.retired-hap-test.mjs');await rm(backendOutput);
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'dsh-embedded-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.alloc(64);bytes.set([127,69,76,70,2,1,1,0]);bytes.writeUInt16LE(183,18);
  const manifest={schemaVersion:1,fileName:'libdsh-native-video.z.so',architecture:'aarch64',resourceName:'fixture.so',byteLength:64,sha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(join(dir,manifest.fileName),bytes);await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  return {dir,bytes,manifest};
}
test('a plugin-local resource works while DevEco installation points to a nonexistent location',async t=>{
  const f=await fixture(t);const previous=process.env.DSH_DEVECO_TESTING_HOME;process.env.DSH_DEVECO_TESTING_HOME=join(f.dir,'missing-testing');
  t.after(()=>{if(previous===undefined)delete process.env.DSH_DEVECO_TESTING_HOME;else process.env.DSH_DEVECO_TESTING_HOME=previous;});
  const result=await embeddedNativeVideoResource(f.dir);assert.equal(result.file,join(f.dir,f.manifest.fileName));assert.equal(result.hash,f.manifest.sha256);
  assert.equal((await embeddedNativeVideoResource(f.dir)).file,result.file);
});
test('a changed binary invalidates the validation cache and rejects tampering',async t=>{
  const f=await fixture(t);await embeddedNativeVideoResource(f.dir);
  f.bytes[40]=1;await writeFile(join(f.dir,f.manifest.fileName),f.bytes);
  await assert.rejects(embeddedNativeVideoResource(f.dir),/integrity/);
});
test('wrong architecture, escaping names, and missing binaries fail before use',async t=>{
  const f=await fixture(t);f.manifest.fileName='../outside.so';await writeFile(join(f.dir,'manifest.json'),JSON.stringify(f.manifest));
  await assert.rejects(embeddedNativeVideoResource(f.dir),/manifest/);
  f.manifest.fileName='libdsh-native-video.z.so';f.bytes.writeUInt16LE(62,18);f.manifest.sha256=createHash('sha256').update(f.bytes).digest('hex');
  await writeFile(join(f.dir,f.manifest.fileName),f.bytes);await writeFile(join(f.dir,'manifest.json'),JSON.stringify(f.manifest));
  await assert.rejects(embeddedNativeVideoResource(f.dir),/architecture/);
  await rm(join(f.dir,f.manifest.fileName));await assert.rejects(embeddedNativeVideoResource(f.dir),e=>e.details?.reason==='native-video-resource-missing');
});
test('retired HAP initialization never signs, installs, wakes, or contacts the device',async()=>{
  const calls=[];const backend=new HdcBackend({hdcPath:process.execPath,execute:async spec=>{calls.push(spec);throw Error('must not run');}});
  await assert.rejects(backend.initializeMirror('test-phone','old.hap'),e=>e.details?.reason==='mirror-hap-retired'&&e.details.dispatchState==='not-sent');
  assert.throws(()=>backend.mirrorPackagePath(),e=>e.details?.reason==='mirror-hap-retired');assert.deepEqual(calls,[]);
});
test('quality profiles lower capture rate and bitrate without unbounded caller parameters',()=>{
  assert.equal(nativeVideoProfile().fps,24);assert.equal(nativeVideoProfile('efficient').fps,15);
  assert.ok(nativeVideoProfile('balanced').bitRate<nativeVideoProfile('smooth').bitRate);
  assert.ok(nativeVideoProfile('efficient').scale>nativeVideoProfile('balanced').scale);
  assert.throws(()=>nativeVideoProfile('invalid'),/quality/);
});
