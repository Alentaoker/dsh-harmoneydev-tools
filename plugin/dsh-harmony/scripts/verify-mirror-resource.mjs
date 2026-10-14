import { build } from 'esbuild';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
export async function verifyMirrorResource(directory) {
  const modulePath = path.join(root, 'artifacts', `.mirror-resource-check-${process.pid}.mjs`);
  await mkdir(path.dirname(modulePath), { recursive: true });
  const compiled = await build({ stdin: { contents:
    `export {verifyHarmonyMirrorArtifact} from ${JSON.stringify(path.join(root, 'scripts/upstream/harmony-mirror-provenance.mjs'))};\n` +
    `export {validatePublicMirrorReceipt} from ${JSON.stringify(path.join(root, 'vendor/lib/harmony/runtime/mirror-signing.ts'))};`,
    resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', packages: 'external', write: false });
  await writeFile(modulePath, compiled.outputFiles[0].contents);
  try {
    const { verifyHarmonyMirrorArtifact, validatePublicMirrorReceipt } = await import(pathToFileURL(modulePath).href);
    const manifest = await verifyHarmonyMirrorArtifact({
      sourceDirectory: path.join(root, 'vendor/third_party/harmony-mirror'), resourcesDirectory: directory,
      expectedOrigin: { repository: 'kexijiang/Piora', commit: '50c1a40398ae6acde8b1284d5170c81cb19dfde6', runId: '37584784712', runAttempt: '1', workflowRef: 'kexijiang/Piora/.github/workflows/harmony-preview.yml@refs/tags/v0.5.5-beta.15' },
    });
    const receipt = JSON.parse(await readFile(path.join(directory, 'harmony-mirror-signature-verification.json'), 'utf8'));
    validatePublicMirrorReceipt(receipt, await readFile(path.join(directory, 'OHScrcpyServer.hap')));
    return manifest;
  } finally { await unlink(modulePath); }
}
