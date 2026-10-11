import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { verifyMirrorResource } from './verify-mirror-resource.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');
const upstream = path.resolve(root, '..', 'Piora-source-review');
const src = name => path.join(root, 'src', name);
// rc.2 replaces preset configs as a whole; reproduce the installed preset declarations.
let patch = '- insert:\n    - id: dshHarmony-host\n      name: dsh-harmony\n\n';
for (const preset of ['standard', 'ptc', 'minimal', 'cordis']) {
  const original = fs.readFileSync(path.join(root, 'compat', `${preset}.patch.yml`), 'utf8');
  const lines = original.split(/\r?\n/);
  const first = lines.findIndex(line => line.startsWith('    - id:'));
  if (first < 0) throw new Error(`Invalid compatibility preset: ${preset}`);
  patch += lines.slice(first).map(line => line.startsWith('    ') ? line.slice(4) : line).join('\n').trimEnd();
  patch += '\n      - id: dshHarmony\n        name: dsh-harmony/agent\n\n';
}
fs.writeFileSync(path.join(root, 'cordis.patch.yml'), patch);
// A checkout builds from its vendored API sources. Maintainers may refresh
// from the pinned upstream checkout before building.
if (fs.existsSync(path.join(upstream, 'app/api/harmony'))) fs.cpSync(path.join(upstream, 'app/api/harmony'), path.join(vendor, 'app/api/harmony'), { recursive: true });
const shared = path.join(vendor, 'app/api/harmony/_shared.ts');
let sharedCode = fs.readFileSync(shared, 'utf8');
sharedCode = sharedCode.replace(/^import \{ admittedByHarness \} from .*;\r?\n/m, '');
sharedCode = sharedCode.replace(/export function requireHarmonyDesktopAccess[\s\S]*?(?=export function requireHarmonyAccess)/,
  `export function requireHarmonyDesktopAccess(request: Request): Response | null {\n return admittedByHarness(request) ? null : Response.json({error:{code:'DESKTOP_AUTH_REQUIRED',message:'Harness authentication required'}},{status:403});\n}\n\n`);
fs.writeFileSync(shared, `import { admittedByHarness } from '../../../../src/gateway';\n` + sharedCode);
const routeFiles = fs.readdirSync(path.join(vendor, 'app/api/harmony'), { recursive: true }).filter(p => String(p).replaceAll('\\', '/').endsWith('/route.ts'));
let generated = `import { withHarnessAdmission } from './gateway';\n`;
for (let i = 0; i < routeFiles.length; i++) generated += `import * as r${i} from ${JSON.stringify('../vendor/app/api/harmony/' + routeFiles[i].replaceAll('\\', '/'))};\n`;
generated += 'export const routes = [\n' + routeFiles.map((p, i) => {
  const routePath = '/api/harmony/' + p.replaceAll('\\', '/').replace('/route.ts', '');
  const methods = [...fs.readFileSync(path.join(vendor, 'app/api/harmony', p), 'utf8').matchAll(/export async function (GET|POST|HEAD)/g)].map(m => m[1]);
  return `{ path: ${JSON.stringify(routePath)}, methods: ${JSON.stringify(methods)}, requestBody: 'buffered', fetch: (request: Request) => withHarnessAdmission(request, (req) => (r${i} as any)[req.method](req)) }`;
}).join(',\n') + '\n];\n';
generated += `import { desktopRoutes } from './desktop'; routes.push(...desktopRoutes);\n`;
fs.writeFileSync(src('routes.ts'), generated);
const aliases = {
  '@earendil-works/pi-ai': src('pi-ai.ts'), '@earendil-works/pi-coding-agent': src('pi-sdk.ts'),
  'next/server': src('next-server.ts'),
};
const adapter = (browser = false) => ({ name: 'piora-platform-adapters', setup(builder) {
  builder.onResolve({ filter: /^@\// }, args => {
    if (args.path === '@/lib/file-access') return { path: src('file-access.ts') };
    if (browser && args.path === '@/hooks/useI18n') return { path: src('i18n.tsx') };
    return { path: path.join(vendor, args.path.slice(2)) + (fs.existsSync(path.join(vendor, args.path.slice(2)) + '.tsx') ? '.tsx' : fs.existsSync(path.join(vendor, args.path.slice(2)) + '.ts') ? '.ts' : '/index.ts') };
  });
  builder.onResolve({ filter: /(?:^|\/)file-access(?:\.ts)?$/ }, () => ({ path: src('file-access.ts') }));
  if (browser) {
    builder.onResolve({ filter: /(?:^|\/)useI18n(?:\.tsx)?$/ }, () => ({ path: src('i18n.tsx') }));
    builder.onResolve({ filter: /(?:^|\/)SmartShellPanel$/ }, () => ({ path: src('LocalTerminal.tsx') }));
  }
  builder.onLoad({ filter: /vendor[\\/].*\.[jt]sx?$/ }, args => {
    let code = fs.readFileSync(args.path, 'utf8');
    if (browser && code.includes('window.piDesktop')) code = `import { harmonyDesktop } from ${JSON.stringify(src('desktop-client.ts'))};\n` + code.replaceAll('window.piDesktop', 'harmonyDesktop');
    if (!browser && code.includes('process.env')) code = `import { harmonyEnvironment } from ${JSON.stringify(src('state.ts'))};\n` + code.replaceAll('process.env', 'harmonyEnvironment()');
    if (args.path.endsWith('branding.ts')) code = `export const APP_DISPLAY_NAME = 'dshHarmony'; export const APP_BRAND = 'dsh'; export function brandText(text: string) { return text.replaceAll('Piora', APP_DISPLAY_NAME).replaceAll('PIORA', 'DSH'); }`;
    return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: path.dirname(args.path) };
  });
}});
const common = { bundle: true, target: 'node24', logLevel: 'info', alias: aliases, packages: 'external', plugins: [adapter()], sourcemap: false, metafile: true };
const native = await build({ ...common, entryPoints: [src('index.ts'), src('agent.ts')], outdir: path.join(root, 'lib'), format: 'esm', platform: 'node', splitting: true });
fs.writeFileSync(path.join(root, 'native-inputs.json'), JSON.stringify(Object.keys(native.metafile.inputs), null, 2));
await build({ ...common, entryPoints: [path.join(vendor, 'lib/harmony/runtime/worker-entry.ts')], outfile: path.join(root, '.harmony-worker/harmony/runtime/worker-entry.js'), format: 'esm', platform: 'node' });
const client = await build({ entryPoints: [src('client.tsx')], outfile: path.join(root, 'lib/client.js'), bundle: true, format: 'cjs', platform: 'browser', target: 'chrome130', alias: aliases, external: ['react', 'react-dom', 'react/jsx-runtime'], plugins: [adapter(true)], jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, logLevel: 'info', write: false, metafile: true });
const js = client.outputFiles.find(p => p.path.endsWith('.js')).text;
const css = client.outputFiles.find(p => p.path.endsWith('.css'))?.text || '';
const style = `const style=document.createElement('style');style.dataset.plugin='dsh-harmony';style.textContent=${JSON.stringify(css)};document.head.appendChild(style);\n`;
fs.writeFileSync(path.join(root, 'lib/client.js'), `window.__ModuleLoader__.load({id:'dsh-harmony',factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${style}${js}\nreturn module.exports;}});`);
fs.writeFileSync(path.join(root, 'client-inputs.json'), JSON.stringify(Object.keys(client.metafile.inputs), null, 2));
for (const folder of ['third_party/harmony-tools', 'third_party/harmony-mirror']) fs.cpSync(path.join(vendor, folder), path.join(root, folder), { recursive: true });
const mirrorResources = path.join(root, 'resources/harmony-mirror');
if (fs.existsSync(mirrorResources)) {
  await verifyMirrorResource(mirrorResources);
  for (const file of ['OHScrcpyServer.hap', 'harmony-mirror-manifest.json', 'harmony-mirror-signature-verification.json', 'SOURCE.md'])
    fs.copyFileSync(path.join(mirrorResources, file), path.join(root, 'third_party/harmony-tools/windows-x64', file));
}
for (const p of ['lib/harmony/runtime/sqlite-inspector.cjs', 'lib/harmony/runtime/PioraHapSigner.java', 'lib/harmony/audio/acoustic-provider.ps1']) {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.copyFileSync(path.join(vendor, p), path.join(root, p));
}
