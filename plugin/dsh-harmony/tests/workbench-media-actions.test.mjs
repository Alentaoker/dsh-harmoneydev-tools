import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temp = await mkdtemp(join(tmpdir(), 'dsh-media-actions-'));
const built = await build({ entryPoints: ['vendor/lib/harmony/media-history.ts', 'vendor/components/workspace/harmony/media-annotations.ts'], bundle: true, platform: 'node', format: 'esm', outdir: join(temp, 'modules') });
const { listHarmonyMediaHistory, deleteHarmonyMedia } = await import(pathToFileURL(join(temp, 'modules/lib/harmony/media-history.js')));
const { editTextMark, textMarkAt } = await import(pathToFileURL(join(temp, 'modules/components/workspace/harmony/media-annotations.js')));
test.after(async () => {
  const target = resolve(temp), parent = resolve(tmpdir());
  assert.equal(dirname(target), parent); assert.ok(target.startsWith(join(parent, 'dsh-media-actions-')));
  await rm(target, { recursive: true, force: true });
});
const config = { storage: { screenshotDirectory: join(temp, 'screenshots'), recordingDirectory: join(temp, 'recordings') } };
let sequence = 0;
async function media(serial = 'DEVICE', kind = 'screenshot', source = 'manual') {
  const filename = `${serial}-2026-10-18T00-00-00-000Z-${(++sequence).toString(16).padStart(8, '0')}.${kind === 'screenshot' ? 'png' : 'mp4'}`;
  const dir = config.storage[kind === 'screenshot' ? 'screenshotDirectory' : 'recordingDirectory']; await mkdir(dir, { recursive: true });
  const path = join(dir, filename), data = Buffer.alloc(64);
  if (kind === 'screenshot') { Buffer.from([137,80,78,71,13,10,26,10]).copy(data); data.write('IHDR',12); data.writeUInt32BE(1,16); data.writeUInt32BE(1,20); }
  await writeFile(path, data);
  if (source !== 'unknown') await writeFile(path + '.origin.json', JSON.stringify({ filename, source }));
  return { filename, kind, path };
}
test('multi-select deletes the files and sidecars, accounts disk bytes, and preserves unselected media', async () => {
  const one = await media(), two = await media('DEVICE','recording'), keep = await media();
  const expected = (await lstat(one.path)).size + (await lstat(one.path+'.origin.json')).size + (await lstat(two.path)).size + (await lstat(two.path+'.origin.json')).size;
  const result = await deleteHarmonyMedia(config, 'DEVICE', [one,two,one]);
  assert.equal(result.deleted.length,2); assert.equal(result.freedBytes,expected); assert.deepEqual(result.errors,[]);
  await assert.rejects(lstat(one.path)); await assert.rejects(lstat(one.path+'.origin.json')); await lstat(keep.path);
});
test('whole selection is validated before deleting; rejects traversal, another device, automation and directories', async () => {
  const keep = await media(), foreign = await media('OTHER'), auto = await media('DEVICE','screenshot','automation');
  for(const serial of [123,null,undefined])await assert.rejects(deleteHarmonyMedia(config,serial,[keep]),/Choose/);
  for (const invalid of [{ kind:'screenshot',filename:'../outside.png' }, foreign, auto]) {
    await assert.rejects(deleteHarmonyMedia(config,'DEVICE',[keep,invalid])); await lstat(keep.path);
  }
  const fake = 'DEVICE-2026-10-18T00-00-00-000Z-eeeeeeee.png'; await mkdir(join(config.storage.screenshotDirectory,fake));
  await assert.rejects(deleteHarmonyMedia(config,'DEVICE',[{kind:'screenshot',filename:fake}]));
});
test('legacy cleanup is explicit and history pagination can expose more than forty manual items', async () => {
  const old = await media('LEGACY','screenshot','unknown');
  await assert.rejects(deleteHarmonyMedia(config,'LEGACY',[old]));
  assert.equal((await deleteHarmonyMedia(config,'LEGACY',[old],'legacy')).deleted.length,1);
  for(let n=0;n<43;n++)await media('PAGES');
  const first = await listHarmonyMediaHistory(config,'PAGES','manual'); assert.equal(first.artifacts.length,40);assert.equal(first.truncated,true);
  const all = await listHarmonyMediaHistory(config,'PAGES','manual',80);assert.equal(all.artifacts.length,43);assert.equal(all.truncated,false);
});
test('text edits replace the selected mark, preserve other marks, support clearing and respect the annotation limit', () => {
  const mark = {tool:'text',x:20,y:30,endX:20,endY:30,text:'第一处',color:'#fff'};
  const initial = editTextMark([],null,mark), edited = editTextMark(initial,0,{...mark,text:'重新编辑'});
  assert.equal(edited.length,1);assert.equal(edited[0].text,'重新编辑');assert.equal(initial[0].text,'第一处');
  assert.equal(textMarkAt(edited,25,35,720,text=>text.length*24),0);assert.equal(textMarkAt(edited,200,200,720,()=>50),-1);
  assert.equal(editTextMark(edited,0,{...mark,text:''}).length,0);
  const full=Array.from({length:200},()=>mark);assert.throws(()=>editTextMark(full,null,mark),/200/);assert.equal(editTextMark(full,0,mark).length,200);
});
