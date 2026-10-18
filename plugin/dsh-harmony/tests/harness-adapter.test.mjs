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
test('operation help is available without dispatching to the phone', async () => {
  const result = await bridge.tool.execute({ operation: 'help', topic: 'run_scenario' }, { agent: { id: 'test-session' }, callId: 'test-call', signal: new AbortController().signal });
  assert.equal(JSON.parse(result.content[0].text).operation, 'run_scenario');
  assert(bridge.prompt.includes('harmony_control'));
});
test('invalid operation arguments and prior cancellation are rejected before dispatch', async () => {
  await assert.rejects(bridge.tool.execute({ operation: 'tap', input: { x: 'invalid' } }, { agent: { id: 'test-session' }, callId: 'bad-call', signal: new AbortController().signal }), /Invalid/);
  await assert.rejects(bridge.tool.execute({ operation: 'list_devices' }, { agent: { id: 'cancelled-session' }, callId: 'cancelled-call', signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(bridge.tool.execute({ operation: 'help' }, { callId: 'no-session', signal: new AbortController().signal }), /active Harness session/);
});

test('unknown wait fields fail before device admission; human validation blocks control even with explicit direct execution', async () => {
  const exec = { agent: { id: 'routing-test' }, callId: 'routing-call', signal: new AbortController().signal };
  await assert.rejects(bridge.tool.execute({ operation: 'wait', input: { milliseconds: 25000 } }, exec), /milliseconds.*Unexpected|Unexpected.*milliseconds/);
  const unregister = bridge.automation.taskRouting.register({ activeAttempt: sessionId => sessionId === 'routing-test' ? { taskId: 't-human', attemptId: 'a-human', mode: 'human', serial: 'fixture-device' } : null });
  try {
    await assert.rejects(bridge.tool.execute({ operation: 'prepare_device', input: {} }, exec), /HUMAN_MODE_READ_ONLY/);
    await assert.rejects(bridge.tool.execute({ operation: 'tap', input: { ref: 'old', generation: 1 } }, exec), /HUMAN_MODE_READ_ONLY/);
    await assert.rejects(bridge.tool.execute({ operation: 'wait', input: { waitMs: 100 }, execution: 'direct', directReason: '明确选择直控' }, exec), /HUMAN_MODE_READ_ONLY/);
  } finally { unregister(); }
  assert.equal(JSON.parse((await bridge.tool.execute({ operation: 'help', topic: 'wait' }, exec)).content[0].text).operation, 'wait');
  const direct = await bridge.tool.execute({ operation: 'help', topic: 'wait', execution: 'direct', directReason: '只看接口' }, exec);
  assert.match(direct.content.at(-1).text, /未创建 dshVerify/);
  assert.equal(direct.execution.kind, 'direct');
  assert.equal(direct.execution.validationRecorded, false);
});
test.after(async () => { for (const cleanup of effects.reverse()) if (typeof cleanup === 'function') await cleanup(); await rm(home, { recursive: true, force: true }); });
