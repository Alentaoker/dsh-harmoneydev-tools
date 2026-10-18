import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { verifyNativeVideoResource } from './verify-native-video-resource.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');
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
// Builds always use the checked-in vendor tree. Refreshing upstream is a
// separate explicit maintenance operation; nearby checkouts cannot alter builds.
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
  const methods = [...fs.readFileSync(path.join(vendor, 'app/api/harmony', p), 'utf8').matchAll(/export async function (GET|POST|HEAD|PUT|PATCH|DELETE|OPTIONS)\b/g)].map(m => m[1]);
  return `{ path: ${JSON.stringify(routePath)}, methods: ${JSON.stringify(methods)}, requestBody: 'buffered', fetch: (request: Request) => withHarnessAdmission(request, (req) => (r${i} as any)[req.method](req)) }`;
}).join(',\n') + '\n];\n';
generated += `import { desktopRoutes } from './desktop'; routes.push(...desktopRoutes);\n`;
fs.writeFileSync(src('routes.ts'), generated);
// The session-log view must be the real dshE2E workbench, not a second copy.
// The two plugins ship as a pair; a standalone build of this repository still
// has the sibling source. Without it the pane degrades to an explicit notice
// instead of silently reimplementing import/delete/rename/analysis.
const pairedWorkbench = path.join(root, '..', 'dsh-e2e', 'src');
const usePairedWorkbench = fs.existsSync(path.join(pairedWorkbench, 'LogWorkbench.jsx'))
  && fs.existsSync(path.join(pairedWorkbench, 'client.css'));
// One implementation of the search-history keyboard rules serves both log views;
// a standalone build keeps a byte-identical contract through the local fallback.
const pairedSearchMenu = path.join(pairedWorkbench, 'log-search-menu.mjs');
const usePairedSearchMenu = fs.existsSync(pairedSearchMenu);
const aliases = {
  '@earendil-works/pi-ai': src('pi-ai.ts'), '@earendil-works/pi-coding-agent': src('pi-sdk.ts'),
  'next/server': src('next-server.ts'),
  '@dsh-e2e-workbench': usePairedWorkbench ? path.join(pairedWorkbench, 'LogWorkbench.jsx') : src('session-log-workbench-unpaired.tsx'),
  '@dsh-e2e-workbench-css': usePairedWorkbench ? path.join(pairedWorkbench, 'client.css') : src('session-log-workbench-unpaired.css'),
  '@dsh-log-search-menu': usePairedSearchMenu ? pairedSearchMenu : src('log-search-menu-unpaired.ts'),
};
if (!usePairedWorkbench) console.warn('dshE2E source not found next to this plugin: the session-log pane will show a pairing notice.');
if (!usePairedSearchMenu) console.warn('dshE2E log-search-menu.mjs not found: the live pane uses the local fallback copy of the search-history rules.');
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
fs.cpSync(path.join(vendor, 'third_party/harmony-tools'), path.join(root, 'third_party/harmony-tools'), { recursive: true,
  filter: source => !/OHScrcpyServer\.hap$|harmony-mirror-(?:manifest|signature-verification)\.json$/.test(source) });
const nativeResource = await verifyNativeVideoResource(path.join(root, 'resources/native-video'));
console.log(nativeResource.present ? `Embedded native video: ${nativeResource.byteLength} bytes` : 'Native video resource absent: import it for a local installation. Screenshot fallback remains available.');
for (const p of ['lib/harmony/runtime/sqlite-inspector.cjs', 'lib/harmony/audio/acoustic-provider.ps1']) {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.copyFileSync(path.join(vendor, p), path.join(root, p));
}
