import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
const root = path.resolve('.'), directory = path.resolve('tests', `.mirror-fixture-${process.pid}`);
const moduleUrl = new URL(`./.mirror-test-${process.pid}.mjs`, import.meta.url);
const compiled = await build({ stdin: { contents:
  `export {HdcBackend} from ${JSON.stringify(path.join(root, 'vendor/lib/harmony/hdc-backend.ts'))};\n` +
  `export {prepareLocalMirrorHap} from ${JSON.stringify(path.join(root, 'vendor/lib/harmony/runtime/mirror-signing.ts'))};\n` +
  `export {previewHapArtifact} from ${JSON.stringify(path.join(root, 'vendor/lib/harmony/runtime/hap-preview.ts'))};`, resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  alias: { '@earendil-works/pi-ai': path.resolve('src/pi-ai.ts'), '@earendil-works/pi-coding-agent': path.resolve('src/pi-sdk.ts') },
});
await writeFile(moduleUrl, compiled.outputFiles[0].contents);
const { HdcBackend, prepareLocalMirrorHap, previewHapArtifact } = await import(moduleUrl.href);
await mkdir(directory);
const fixtureFiles = [];
async function hap(name, api) {
  const zip = new JSZip(); zip.file('module.json', JSON.stringify({ app: { bundleName: 'com.ohos.scrcpy.server', versionName: 'test', versionCode: 1, minAPIVersion: api }, module: { name: 'entry', type: 'entry', abilities: [{ name: 'EntryAbility' }] } }));
  const file = path.join(directory, name + '.hap'); await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' })); fixtureFiles.push(file); return file;
}
const encodedHap = await hap('encoded-api', 260000026), plainHap = await hap('plain-api', 26);
test.after(async () => { for (const file of fixtureFiles) await unlink(file); await rmdir(directory); await unlink(moduleUrl); });
function backend(api) {
  const calls = [];
  const instance = new HdcBackend({ hdcPath: process.execPath, execute: async spec => {
    calls.push(spec); assert.equal(spec.operation, 'device_info');
    return { stdout: Buffer.from(String(api)), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1 };
  } });
  instance.requireUnlockedScreen = async () => {};
  return { instance, calls };
}
test('HAP minimum API supports encoded Harmony versions and ordinary API numbers', async () => {
  assert.equal((await previewHapArtifact(encodedHap)).minApiVersion, 26);
  assert.equal((await previewHapArtifact(plainHap)).minApiVersion, 26);
});
test('API 24 cannot initialize an API 26 mirror; no signing or install is sent', async () => {
  const { instance, calls } = backend(24);
  instance.prepareMirrorHap = async () => { throw new Error('Signing must not start'); };
  await assert.rejects(instance.initializeMirror('test-phone', encodedHap), error => error.details?.reason === 'mirror-device-api-incompatible' && error.details.deviceApi === 24 && error.details.requiredApi === 26);
  assert.equal(calls.length, 1);
});
test('unknown device API is reported before signing or installation', async () => {
  const { instance } = backend('unknown');
  await assert.rejects(instance.initializeMirror('test-phone', encodedHap), error => error.details?.reason === 'mirror-device-api-unknown');
});
test('matching API can proceed to signing', async () => {
  const { instance } = backend(26), marker = new Error('signing fixture boundary');
  instance.observeMirrorInstallation = async () => undefined;
  instance.prepareMirrorHap = async () => { throw marker; };
  await assert.rejects(instance.initializeMirror('test-phone', encodedHap), error => error === marker);
});
const options = () => ({ sourceHapPath: encodedHap, hdcPath: process.execPath, deviceUdid: '0'.repeat(64), cacheDirectory: path.join(directory, 'unused-cache'), execute: async () => { throw new Error('No external signing command expected'); } });
test('missing mirror receipt is a resource error, not a developer-login error', async () => {
  await assert.rejects(prepareLocalMirrorHap(options()), error => error.details?.reason === 'mirror-release-resources-missing' && error.details.dispatchState === 'not-sent');
});
test('a fabricated or mismatched receipt cannot reach signing', async () => {
  const receipt = path.join(directory, 'harmony-mirror-signature-verification.json');
  await writeFile(receipt, JSON.stringify({ passed: true })); fixtureFiles.push(receipt);
  await assert.rejects(prepareLocalMirrorHap(options()), error => error.details?.reason === 'mirror-release-resources-invalid');
});
