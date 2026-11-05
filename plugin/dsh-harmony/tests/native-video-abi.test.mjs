import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access, cp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { elfDynamicSymbols, matchNativeVideoResources } from '../vendor/lib/harmony/native-video-elf.mjs';
import { verifyNativeVideoResource } from '../scripts/verify-native-video-resource.mjs';

const output = 'tests/.native-video-abi-test.mjs';
await build({ stdin: { contents: "export * from './vendor/lib/harmony/native-video-resource'; export * from './vendor/lib/harmony/native-video-startup';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: output });
const { embeddedNativeVideoResources, selectNativeVideoResource, nativeVideoLoaderFailure, waitForNativeVideoReady } = await import('./.native-video-abi-test.mjs');
await rm(output);
const resources = await embeddedNativeVideoResources(resolve('resources/native-video'));
const [legacy, current] = resources;

// Small ARM64 ELF fixture exporting a chosen symbol set. No real system library
// or private device file is checked into tests; only the vendor imports are used.
function exportElf(names) {
  const strings = Buffer.from('\0' + names.join('\0') + '\0'), symbolOffset = 256, symbolBytes = (names.length + 1) * 24, stringOffset = symbolOffset + symbolBytes;
  const b = Buffer.alloc(stringOffset + strings.length);
  b.set([127,69,76,70,2,1,1]); b.writeUInt16LE(183,18); b.writeBigUInt64LE(64n,40); b.writeUInt16LE(64,58); b.writeUInt16LE(3,60);
  b.writeUInt32LE(3,132); b.writeBigUInt64LE(BigInt(stringOffset),152); b.writeBigUInt64LE(BigInt(strings.length),160);
  b.writeUInt32LE(11,196); b.writeBigUInt64LE(BigInt(symbolOffset),216); b.writeBigUInt64LE(BigInt(symbolBytes),224); b.writeUInt32LE(1,232); b.writeBigUInt64LE(24n,248);
  let nameOffset = 1;
  names.forEach((name,i) => { const at = symbolOffset + (i+1)*24; b.writeUInt32LE(nameOffset,at); b[at+4]=0x10; b.writeUInt16LE(1,at+6); nameOffset+=Buffer.byteLength(name)+1; });
  strings.copy(b,stringOffset); return b;
}
function probe(bytes, seen = []) { return async (args, operation) => { assert.equal(operation,'native_video_abi_probe'); assert.deepEqual(args.slice(0,3),['file','recv','/system/lib64/libprotobuf.z.so']); seen.push(args[3]); await writeFile(args[3],bytes); return ''; }; }

test('both original vendor binaries are pinned and expose distinct complete protobuf requirements',async()=>{
  assert.equal(legacy.id,'protobuf-legacy');assert.equal(current.id,'protobuf-current');
  assert.equal(legacy.protobufSymbols.length,61);assert.equal(current.protobufSymbols.length,50);
  assert.ok(legacy.protobufSymbols.some(s=>s.includes('SetMapDirty')));assert.ok(!current.protobufSymbols.some(s=>s.includes('SetMapDirty')));
  const verified=await verifyNativeVideoResource(resolve('resources/native-video'));assert.equal(verified.variants.length,2);assert.equal(verified.byteLength,508270);
});
test('an old ABI keeps the working legacy binary, independent of a device reporting 7.0/API26',async()=>{
  const seen=[];const selected=await selectNativeVideoResource(resources,probe(exportElf(legacy.protobufSymbols),seen));
  assert.equal(selected.resource.id,'protobuf-legacy');assert.equal(selected.abi.status,'symbols-matched');
  assert.ok(selected.abi.candidates[1].missing.length>0);await assert.rejects(access(dirname(seen[0])),{code:'ENOENT'});
});
test('the new ABI selects the 6.9 original without first dispatching an incompatible old extension',async()=>{
  const calls=[];const selected=await selectNativeVideoResource(resources,probe(exportElf(current.protobufSymbols),calls));
  assert.equal(selected.resource.id,'protobuf-current');assert.equal(calls.length,1);assert.ok(selected.abi.candidates[0].missing.length>0);
});
test('a superset ABI preserves the tested legacy preference',async()=>{
  const selected=await selectNativeVideoResource(resources,probe(exportElf([...new Set([...legacy.protobufSymbols,...current.protobufSymbols])])));
  assert.equal(selected.resource.id,'protobuf-legacy');
});
test('a missing symbol in both variants fails closed before any extension is sent',async()=>{
  const calls=[];await assert.rejects(selectNativeVideoResource(resources,probe(exportElf(['unrelated']),calls)),e=>e.details.reason==='native-video-abi-incompatible'&&e.retryable===false&&e.details.abi.candidates.every(v=>v.missing.length));
  assert.equal(calls.length,1);await assert.rejects(access(dirname(calls[0])),{code:'ENOENT'});
});
test('library read restrictions retain only an explicitly unverified legacy fallback',async()=>{
  const selected=await selectNativeVideoResource(resources,async()=>{throw Error('permission denied');});
  assert.equal(selected.resource.id,'protobuf-legacy');assert.equal(selected.abi.status,'unverified');
  await assert.rejects(selectNativeVideoResource([current],async()=>{throw Error('permission denied');}),e=>e.details.reason==='native-video-abi-probe-unavailable');
});
test('a cancelled probe neither falls back nor leaves the pulled library behind',async()=>{
  const abort=new AbortController(),seen=[];
  await assert.rejects(selectNativeVideoResource(resources,async(args)=>{seen.push(args[3]);await writeFile(args[3],exportElf(legacy.protobufSymbols));abort.abort();return '';},abort.signal),e=>e.code==='COMMAND_ABORTED');
  await assert.rejects(access(dirname(seen[0])),{code:'ENOENT'});
  let called=false;await assert.rejects(selectNativeVideoResource(resources,async()=>{called=true;},abort.signal),e=>e.code==='COMMAND_ABORTED');assert.equal(called,false);
});
test('malformed system ELF data does not become a successful compatibility result',async()=>{
  await assert.rejects(selectNativeVideoResource(resources,probe(Buffer.alloc(64))),e=>e.details.reason==='native-video-abi-probe-invalid');
  const b=exportElf(['ok']);b.writeBigUInt64LE(0xffffffffffffffffn,40);assert.throws(()=>elfDynamicSymbols(b),/Invalid ARM64/);
  const c=exportElf(['ok']);c.writeUInt32LE(1000,232);assert.throws(()=>elfDynamicSymbols(c),/Invalid ARM64/);
});
test('the symbol reader respects dynamic export visibility and ignores undefined weak imports',()=>{
  const b=exportElf(['one','two']);b[256+24+5]=2;assert.deepEqual([...elfDynamicSymbols(b).exports],['two']);
  b.writeUInt16LE(0,256+48+6);b[256+48+4]=0x20;assert.equal(elfDynamicSymbols(b).imports.size,0);
});
test('manifest alternatives cannot escape, repeat a name, or hide a corrupt unselected binary',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-abi-manifest-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await cp(resolve('resources/native-video'),dir,{recursive:true});const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
  manifest.variants[1].fileName='../escape.so';await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));await assert.rejects(embeddedNativeVideoResources(dir),/manifest/);
  manifest.variants[1].fileName=manifest.variants[0].fileName;await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));await assert.rejects(embeddedNativeVideoResources(dir),/manifest/);
  manifest.variants[1].fileName='libdsh-native-video-6.9.z.so';await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  const file=join(dir,manifest.variants[1].fileName),bytes=await readFile(file);bytes[100]^=1;await writeFile(file,bytes);
  await assert.rejects(embeddedNativeVideoResources(dir),/integrity/);await assert.rejects(verifyNativeVideoResource(dir),/校验/);
});
test('the issue loader message and XPM denial are permanent failures with distinct reasons',()=>{
  const error=nativeVideoLoaderFailure('MUSL-LDSO: relocating failed: symbol not found. s=_ZN6google8protobuf8internal12MapFieldBase11SetMapDirtyEv');
  assert.equal(error.details.reason,'native-video-loader-abi-incompatible');assert.equal(error.retryable,false);assert.match(error.details.symbol,/SetMapDirty/);
  assert.equal(nativeVideoLoaderFailure('MUSL-LDSO: Xpm check failed: errno for mmap is: 13').details.reason,'native-video-loader-integrity-rejected');
  assert.equal(nativeVideoLoaderFailure('Server starting up'),undefined);
});
test('a daemon that dies after its PID probe fails before the 12 second RPC timeout',async()=>{
  let callback,probes=0;const start=Date.now();
  await assert.rejects(waitForNativeVideoReady({waitForReady(_deadline,cb){callback=cb;}},async()=>{probes++;return 'symbol not found: MapFieldBase::SetMapDirty';}),e=>e.details.reason==='native-video-loader-abi-incompatible');
  assert.equal(probes,1);assert.ok(Date.now()-start<3000);callback(); // Late callback cannot settle twice or restart polling.
});
test('a ready RPC schedules no loader probes and an abort settles an in-flight wait',async()=>{
  let probes=0;await waitForNativeVideoReady({waitForReady(_d,cb){cb();}},async()=>{probes++;return '';});assert.equal(probes,0);
  const abort=new AbortController();const pending=waitForNativeVideoReady({waitForReady(){}},async()=>'',abort.signal);abort.abort();await assert.rejects(pending,e=>e.code==='COMMAND_ABORTED');
});
