import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = await mkdtemp(join(tmpdir(), 'dshHarmony-test-'));
process.env.DSH_HOME = home;
const { apply } = await import('../lib/index.js');
let bridge;
const routes = new Map(), effects = [], events = new Map();
const ctx = {
  reflect: { provide(_name, value) { bridge = value; return () => {}; } },
  connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  sessions: { list: () => [] },
  effect(register) { effects.push(register()); },
  on(event, fn) { events.set(event, fn); },
};
apply(ctx);
test('GET bridge accepts a bodyless request; POST validation stays bounded', async () => {
  const route = routes.get('/api/harmony/manual');
  assert.equal(route.requestBody, 'buffered');
  const response = await route.fetch(new Request('http://localhost/api/harmony/manual', { method: 'POST' }));
  assert.equal(response.status, 415);
  assert.equal(routes.get('/api/harmony/devices').requestBody, 'buffered');
});

test('every exported HTTP method is registered, including configuration PUT', async () => {
  const root = new URL('../vendor/app/api/harmony/', import.meta.url);
  for (const file of await readdir(root, { recursive: true })) {
    if (!String(file).replaceAll('\\', '/').endsWith('/route.ts')) continue;
    const text = await readFile(new URL(String(file).replaceAll('\\', '/'), root), 'utf8');
    const expected = [...text.matchAll(/export async function (GET|POST|HEAD|PUT|PATCH|DELETE|OPTIONS)\b/g)].map(m => m[1]);
    const route = routes.get('/api/harmony/' + String(file).replaceAll('\\', '/').replace('/route.ts', ''));
    assert.deepEqual(route?.methods, expected, file);
  }
  const route = routes.get('/api/harmony/config');
  assert.ok(route.methods.includes('PUT'));
  const response = await route.fetch(new Request('http://localhost/api/harmony/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storage: { screenshotDirectory: join(home, 'screenshots') } }) }));
  assert.equal(response.status, 200);
  const saved = JSON.parse(await readFile(join(home, 'storages/dshHarmony/harmony.json'), 'utf8'));
  assert.equal(saved.storage.screenshotDirectory, join(home, 'screenshots'));
});
test('manual host registers no AI tool or validation bridge',()=>{assert.equal(bridge,undefined);assert.equal(events.size,0);});

test('cleanup',async()=>{for(const cleanup of effects.reverse())if(typeof cleanup==='function')await cleanup();await rm(home,{recursive:true,force:true});});
