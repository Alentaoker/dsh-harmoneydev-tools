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
await writeFile(join(lib, 'client.js'), `window.__ModuleLoader__.load({id:'dsh-log-analysis',factory:(require)=>{const module={exports:{}};const exports=module.exports;const id='dsh-log-analysis-style';let style=document.getElementById(id);if(!style){style=document.createElement('style');style.id=id;document.head.appendChild(style);}style.textContent=${JSON.stringify(css)};\n${js}\nreturn module.exports;}});`);

await writeFile(join(root,'cordis.patch.yml'),'- insert:\n    - id: dshLogAnalysis-host\n      name: dsh-log-analysis\n');
console.log('dsh-log-analysis built ('+sources.length+' modules)');
