import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
test.after(async () => { for (const cleanup of effects.reverse()) if (typeof cleanup === 'function') await cleanup(); await rm(home, { recursive: true, force: true }); });
