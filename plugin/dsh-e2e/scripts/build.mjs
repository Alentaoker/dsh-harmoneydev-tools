import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '..');
const src = join(root, 'src'), lib = join(root, 'lib');
await mkdir(lib, { recursive: true });

// Deterministic output: copy the current module set, then remove modules that no
// longer exist in src. Without this, deleted runner modules (engine/executor/rpc)
// would survive in lib and keep shipping inside the plugin bundle.
const sources = (await readdir(src)).filter(file => file.endsWith('.mjs'));
for (const file of sources) await copyFile(join(src, file), join(lib, file));
const keep = new Set(sources);
const stale = [];
for (const file of await readdir(lib)) {
  if (!file.endsWith('.mjs') || keep.has(file)) continue;
  await rm(join(lib, file), { force: true });
  stale.push(file);
}

const client = await build({ entryPoints: [join(src, 'client.jsx')], outfile: join(lib, 'client.js'), bundle: true, format: 'cjs', platform: 'browser', target: 'chrome130', external: ['react', 'react/jsx-runtime'], jsx: 'automatic', write: false });
const js = client.outputFiles.find(f => f.path.endsWith('.js')).text, css = client.outputFiles.find(f => f.path.endsWith('.css'))?.text || '';
await writeFile(join(lib, 'client.js'), `window.__ModuleLoader__.load({id:'dsh-e2e',factory:(require)=>{const module={exports:{}};const exports=module.exports;const id='dsh-e2e-style';let style=document.getElementById(id);if(!style){style=document.createElement('style');style.id=id;document.head.appendChild(style);}style.textContent=${JSON.stringify(css)};\n${js}\nreturn module.exports;}});`);

// rc.2 replaces entire preset declarations: preserve the latest Harmony layer.
let patch = '- insert:\n    - id: dshE2E-host\n      name: dsh-e2e\n\n';
let harmonyPatch;
for (const sibling of ['../dsh-harmony', '../dsh-harmony-plugin']) {
  try { harmonyPatch = await readFile(resolve(root, sibling, 'cordis.patch.yml'), 'utf8'); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!harmonyPatch) throw new Error('Build dshHarmony first; its cordis.patch.yml is required');
const presets = harmonyPatch.slice(harmonyPatch.indexOf('- id: preset-standard'));
patch += presets.replace(/(      - id: dshHarmony\r?\n        name: dsh-harmony\/agent)/g, '$1\n      - id: dshE2E\n        name: dsh-e2e/agent');
await writeFile(join(root, 'cordis.patch.yml'), patch);
console.log(`dshE2E built (${sources.length} modules)${stale.length ? `; removed stale lib output: ${stale.join(', ')}` : ''}`);
