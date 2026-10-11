import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '..');
await mkdir(join(root,'lib'),{recursive:true});
for(const file of await readdir(join(root,'src'))) if(file.endsWith('.mjs')) await copyFile(join(root,'src',file),join(root,'lib',file));
const client = await build({entryPoints:[join(root,'src/client.jsx')],bundle:true,format:'cjs',platform:'browser',target:'chrome130',external:['react','react/jsx-runtime'],jsx:'automatic',write:false});
await writeFile(join(root,'lib/client.js'),`window.__ModuleLoader__.load({id:'dsh-e2e',factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});`);
// rc.2 replaces entire preset declarations: preserve the latest Harmony layer.
let patch = '- insert:\n    - id: dshE2E-host\n      name: dsh-e2e\n\n';
let harmonyPatch;
for (const sibling of ['../dsh-harmony', '../dsh-harmony-plugin']) {
  try { harmonyPatch=await readFile(resolve(root,sibling,'cordis.patch.yml'),'utf8'); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!harmonyPatch) throw new Error('Build dshHarmony first; its cordis.patch.yml is required');
const presets=harmonyPatch.slice(harmonyPatch.indexOf('- id: preset-standard'));
patch += presets.replace(/(      - id: dshHarmony\r?\n        name: dsh-harmony\/agent)/g,'$1\n      - id: dshE2E\n        name: dsh-e2e/agent');
await writeFile(join(root,'cordis.patch.yml'),patch);
console.log('dshE2E built with e2e 0.19.0 and four Harness presets');
