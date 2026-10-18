// Fourth-round regressions (H01/H02): real PromptRun registry + wrapper event
// handlers, and real registered HTTP handlers. Only device/host effects are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { createService } from '../src/service.mjs';
import { registerRoutes } from '../src/index.mjs';

const repo = new URL('../../../', import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'dsh-fourth-fixed-'));

function manager() {
  return {
    async applications() { return [{ bundleName: 'com.demo.app' }]; },
    async listDevices() { return []; },
    async listProcesses() { return [{ pid: 1, name: 'com.demo.app' }]; },
    async readLogs() { return []; },
    streamLogs(serial, callback, signal) { callback([{ pid: 1, tag: 'com.demo.app', message: 'fixture-capture-line', level: 'info' }]); return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
  };
}

async function fixture(name) {
  const m = manager();
  const host = createService({ dshHarmony: { automation: { getManager: () => m } } }, join(root, name));
  await host.status({ sessionId: 's' });
  const task = await host.validation.saveTask('s', { title: 'fixture', requirement: 'r', checkpoints: [{ id: 'c', description: 'check' }] });
  const started = await host.validation.beginValidation('s', { taskId: task.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true });
  return { host, v: host.validation, m, taskId: task.taskId, attemptId: started.attemptId, id: `${task.taskId}/${started.attemptId}` };
}

const registryUrl = new URL('plugin/dsh-harmony/vendor/lib/prompt-run-registry.ts', repo).href;
const entry = new URL('plugin/dsh-harmony/src/index.ts', repo).href;
const stubs = {
  './state': `export const dataRoot=${JSON.stringify(join(root, 'harmony'))}; export function setHost(){}`,
  '../vendor/extensions/piora-harmony': `import { getActivePromptRun, registerPromptRunCleanup } from ${JSON.stringify(registryUrl)};
export default function (host) {
  host.registerTool({ name: 'harmony_control', description: 'fixture', async execute() {
    globalThis.__fourthFixed.leaseHeld = true;
    const run = getActivePromptRun('s');
    registerPromptRunCleanup(run, async () => {
      if (globalThis.__fourthFixed.failCleanup) throw new Error('fixture-control-release-failure');
      globalThis.__fourthFixed.leaseHeld = false;
    });
    return { content: [{ type: 'text', text: 'fixture control dispatched' }], details: { dispatchState: 'sent' } };
  } });
}`,
  '../vendor/lib/harmony': `export function getHarmonyDeviceManager() { return globalThis.__fourthFixed.manager; }`,
  './routes': `export const routes = [];`,
  'registry-brand': `export const APP_DISPLAY_NAME = 'Fixture';`,
  'registry-runtime': `export function getRuntimeAgentDataDirectory() { return ${JSON.stringify(join(root, 'runtime-data'))}; }`,
};
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === entry) {
      if (stubs[specifier]) return { url: 'fourth-fixed-stub:' + encodeURIComponent(specifier), shortCircuit: true };
      if (specifier === '../vendor/lib/prompt-run-registry') return { url: registryUrl, shortCircuit: true };
      if (['./task-routing', './validation-bridge'].includes(specifier)) return { url: new URL(specifier + '.ts', entry).href, shortCircuit: true };
    }
    if (context.parentURL === registryUrl && specifier === './branding.ts') return { url: 'fourth-fixed-stub:registry-brand', shortCircuit: true };
    if (context.parentURL === registryUrl && specifier === './runtime-home.ts') return { url: 'fourth-fixed-stub:registry-runtime', shortCircuit: true };
    return next(specifier, context);
  },
  load(id, context, next) {
    if (id.startsWith('fourth-fixed-stub:')) return { format: 'module', source: stubs[decodeURIComponent(id.slice('fourth-fixed-stub:'.length))], shortCircuit: true };
    return next(id, context);
  },
});

const { apply } = await import(entry);
const runs = await import(registryUrl);
let seq = 0;
function bind(f) {
  globalThis.__fourthFixed = globalThis.__fourthFixed || { leaseHeld: false, failCleanup: false };
  globalThis.__fourthFixed.manager = f.m;
  let bridge;
  const events = new Map();
  const ctx = {
    dshE2E: { validation: f.v },
    attachments: { async saveImage() { return { id: 'fake-image' }; } },
    reflect: { provide(name, value) { bridge = value; return () => {}; } },
    effect: fn => fn(), on: (event, fn) => events.set(event, fn), sessions: { list: () => [] },
  };
  apply(ctx);
  bridge.automation.taskRouting.register({ activeAttempt: sessionId => f.v.activeAttempt(sessionId) });
  return { tool: bridge.tool, events };
}
async function tap(tool, callId) {
  return tool.execute({ operation: 'tap', input: { serial: 'SN1', x: 1, y: 1 } }, { agent: { id: 's' }, callId, signal: new AbortController().signal });
}

test('H01-A：真实 registry 清理失败时不得确认 released', async () => {
  const f = await fixture('release-failure');
  try {
    const { tool, events } = bind(f);
    globalThis.__fourthFixed.failCleanup = true;
    await tap(tool, `failed-${++seq}`);
    assert.equal(runs.getActivePromptRun('s') !== undefined, true);
    await events.get('agent/turn-stopping')({ agent: { id: 's' } });
    assert.equal(runs.getActivePromptRun('s'), undefined, '真实 registry 已移除 run');
    assert.equal(globalThis.__fourthFixed.leaseHeld, true, 'fake 控制仍持有');
    const report = await f.host.report(f.id, { sessionId: 's' });
    assert.equal(report.run.controlRelease.released, false);
    assert.equal(report.run.controlRelease.cleanupFailures >= 1, true);
    assert.equal(report.run.checks.leaseReleased, false, '清理失败不得显示已释放');
  } finally { globalThis.__fourthFixed.failCleanup = false; await f.host.dispose(); }
});

test('H01-B：跨 AI 回复重新获取控制后旧回执失效；迟到旧回执被拒绝', async () => {
  const f = await fixture('reacquire');
  try {
    const { tool, events } = bind(f);
    globalThis.__fourthFixed.failCleanup = false;
    globalThis.__fourthFixed.leaseHeld = false;
    await tap(tool, `turn1-${++seq}`);
    await events.get('agent/turn-stopping')({ agent: { id: 's' } });
    const first = await f.host.report(f.id, { sessionId: 's' });
    assert.equal(first.run.controlRelease.released, true, '成功清理才确认释放');
    assert.equal(globalThis.__fourthFixed.leaseHeld, false);
    const oldRunId = first.run.controlRelease.runId;
    const oldConfirmedAt = first.run.controlRelease.confirmedAt;

    await tap(tool, `turn2-${++seq}`);
    const second = await f.host.report(f.id, { sessionId: 's' });
    assert.equal(globalThis.__fourthFixed.leaseHeld, true, '下一回复重新获得控制');
    assert.equal(second.run.controlRelease.released, false, '新获取使旧释放状态失效');
    assert.notEqual(second.run.controlRelease.confirmedAt, oldConfirmedAt);
    assert.equal(second.run.checks.leaseReleased, false);

    const stale = await f.v.confirmControlRelease('s', { taskId: f.taskId, attemptId: f.attemptId, released: true, runId: oldRunId, source: 'late-old-receipt' });
    assert.equal(stale.recorded, false);
    assert.equal(stale.stale, true);
    const afterStale = await f.host.report(f.id, { sessionId: 's' });
    assert.equal(afterStale.run.controlRelease.released, false, '迟到旧回执不能覆盖新控制');

    await events.get('agent/turn-stopping')({ agent: { id: 's' } });
    const final = await f.host.report(f.id, { sessionId: 's' });
    assert.equal(final.run.controlRelease.released, true);
  } finally { await f.host.dispose(); }
});

test('H01-C：session-disposed 同样使用真实清理结果；缺失 run 不确认释放', async () => {
  const f = await fixture('dispose-path');
  try {
    const { tool, events } = bind(f);
    globalThis.__fourthFixed.failCleanup = true;
    await tap(tool, `dispose-${++seq}`);
    await events.get('session/disposed')({ id: 's' });
    const report = await f.host.report(f.id, { sessionId: 's' });
    assert.equal(report.run.controlRelease.released, false);
    assert.equal(report.run.controlRelease.source, 'session-disposed');

    // A turn-stopping with no matching PromptRun must not claim a release either.
    const missing = await f.v.confirmControlRelease('s', { taskId: f.taskId, attemptId: f.attemptId, released: true, runId: 'no-such-run', source: 'missing-run' });
    assert.equal(missing.recorded, false);
    assert.equal(missing.stale, true);
  } finally { globalThis.__fourthFixed.failCleanup = false; await f.host.dispose(); }
});

test('H02：当前/全部模式下真实路由的下载与导出正文', async () => {
  const f = await fixture('routes');
  try {
    const foreignTask = await f.v.saveTask('other', { title: 'foreign', requirement: 'r', checkpoints: [{ id: 'c', description: 'check' }] });
    const foreign = await f.v.beginValidation('other', { taskId: foreignTask.taskId, serial: 'SN2', mode: 'ai', verifyExisting: true });
    const capture = await f.v.startCapture('other', { taskId: foreignTask.taskId, attemptId: foreign.attemptId, logAppBundle: 'com.demo.app' });
    await f.v.stopCapture('other', { captureId: capture.captureId });
    const own = await f.v.startCapture('s', { taskId: f.taskId, attemptId: f.attemptId, logAppBundle: 'com.demo.app' });
    await f.v.stopCapture('s', { captureId: own.captureId });

    const routes = new Map();
    registerRoutes({ effect: fn => fn(), connection: { fetch: { register: route => { routes.set(route.path, route); return () => {}; } } } }, f.host);
    const path = '/api/dsh-e2e/validation/capture-file';
    const exportPath = '/api/dsh-e2e/log-export';
    const query = (params) => new Request('http://fixture' + path + '?' + new URLSearchParams(params));
    const base = { sessionId: 's', taskId: foreignTask.taskId, attemptId: foreign.attemptId, captureId: capture.captureId };

    const allFile = await routes.get(path).fetch(query({ ...base, scope: 'all' }));
    assert.equal(allFile.status, 200);
    assert.match(await allFile.text(), /fixture-capture-line/);
    const currentForeign = await routes.get(path).fetch(query(base));
    assert.equal(currentForeign.status, 404, '当前会话不能下载外会话采集');

    const ownFile = await routes.get(path).fetch(query({ sessionId: 's', taskId: f.taskId, attemptId: f.attemptId, captureId: own.captureId }));
    assert.equal(ownFile.status, 200);
    assert.match(await ownFile.text(), /fixture-capture-line/);

    const exportQuery = (params) => new Request('http://fixture' + exportPath + '?' + new URLSearchParams(params));
    const foreignExport = await routes.get(exportPath).fetch(exportQuery({ sessionId: 's', scope: 'all', id: `${foreignTask.taskId}/${foreign.attemptId}` }));
    assert.equal(foreignExport.status, 200);
    const body = await foreignExport.text();
    assert.equal(body.includes('fixture-capture-line'), true);
    assert.equal(Buffer.byteLength(body) > 0, true);
    const currentExport = await routes.get(exportPath).fetch(exportQuery({ sessionId: 's', id: `${foreignTask.taskId}/${foreign.attemptId}` }));
    assert.equal(currentExport.status, 404, '当前会话导出外会话必须失败而非空 200');
    const missingExport = await routes.get(exportPath).fetch(exportQuery({ sessionId: 's', scope: 'all', id: `${f.taskId}/attempt-doesnotexist` }));
    assert.equal(missingExport.status, 404, '无记录不得静默返回空文件');
  } finally { await f.host.dispose(); }
});

test.after(async () => { hook.deregister(); await rm(root, { recursive: true, force: true }); });
