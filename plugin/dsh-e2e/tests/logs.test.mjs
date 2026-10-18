import './profile-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLogTarget, startLogCollection, logPage, redactLog, logTime } from '../src/logs.mjs';
import { createService } from '../src/service.mjs';
import { apply } from '../src/agent.mjs';

const entry = (pid, timestamp, message = '目标应用输出', level = 'info') => ({ pid, timestamp, level, tag: 'AppTag', message, raw: message });
function fixture(extra = {}) {
  let emit; let processes = [{ pid: 61, name: 'test.app' }];
  const manager = { async listProcesses() { return processes; }, async readLogs(options) { assert.equal(options.serial, 'TEST-SERIAL'); assert.equal(options.limit, 200); return [entry(999, '10-12 01:00:00.000')]; }, async streamLogs(_s, cb, signal) { emit = cb; cb([entry(99, '10-12 01:00:00.001')]); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }, ...extra };
  const job = { id: 'test', device: { serial: 'TEST-SERIAL' }, lease: { token: 'PRIVATE-LEASE' }, controller: new AbortController(), logTarget: { bundleName: 'test.app' }, logs: [], pendingLogs: [] };
  return { manager, job, emit: entries => emit(entries), setProcesses: value => { processes = value; } };
}
test('日志目标按应用名称自动识别，歧义和缺目标明确拒绝；日志绑定不重启应用', async () => {
  const m = { async applications(_s, name, bundle) { return bundle ? [{ bundleName: bundle, process: 'custom.worker' }] : name === '测试' ? [{ bundleName: 'test.app', label: name }] : [{ bundleName: 'test.app' }, { bundleName: 'test.app.launcher' }]; } };
  assert.equal((await resolveLogTarget(m, 's', { appName: '测试' })).bundleName, 'test.app');
  assert.equal((await resolveLogTarget(m, 's', { logAppBundle: 'test.app' })).source, 'logAppBundle');
  await assert.rejects(resolveLogTarget(m, 's', { appName: '歧义' }), /2 个候选/);
  await assert.rejects(resolveLogTarget(m, 's', {}), /缺少日志目标/);
  assert.equal(await resolveLogTarget(m, 's', { collectLogs: false }), undefined);
});
test('采集排除历史和近似包名，跟踪新进程，PID 被其他应用复用后不误收', async () => {
  const f = fixture(), c = await startLogCollection(f.manager, f.job);
  try {
    f.emit([entry(61, '10-12 00:59:59.000'), entry(61, '10-12 01:00:01.000'), entry(99, '10-12 01:00:01.000', 'test.app.launcher 不应收集')]);
    f.setProcesses([{ pid: 61, name: 'other.app' }, { pid: 62, name: 'test.app:worker' }]); await c.refresh();
    f.emit([entry(61, '10-12 01:00:02.000', '其他应用'), entry(62, '10-12 01:00:02.000', '新进程')]);
    assert.deepEqual(f.job.logs.map(e => e.message), ['目标应用输出', '新进程']);
    assert.equal(f.job.logCollection.excludedHistory, 1);
    assert.deepEqual(f.job.logCollection.observedPids, [61, 62]);
  } finally { await c.stop(); }
  assert.equal(f.job.logCollection.status, 'captured');
});
test('采集失败与正常空日志分别报告；无法确认时间边界时不冒充精确时间段', async () => {
  const failed = fixture({ async streamLogs() { throw new Error('permission denied'); } });
  const c1 = await startLogCollection(failed.manager, failed.job); await c1.stop();
  assert.equal(failed.job.logCollection.status, 'failed'); assert.match(failed.job.logCollection.warnings.join(), /permission denied/);
  const empty = fixture({ async readLogs() { throw new Error('tail unavailable'); } });
  const c2 = await startLogCollection(empty.manager, empty.job); await c2.stop();
  assert.equal(empty.job.logCollection.status, 'empty'); assert.equal(empty.job.logCollection.boundary, 'receive-time-only');
  assert.match(empty.job.logCollection.warnings.join(), /历史/);
});
test('日志保留上限、正文分页和级别过滤有效，密钥不会交给模型', async () => {
  const f = fixture(), c = await startLogCollection(f.manager, f.job);
  try { f.emit(Array.from({ length: 1100 }, (_, i) => entry(61, '10-12 01:00:01.000', `${i} api_key=private-value Bearer PRIVATE-LEASE TEST-SERIAL`, i % 2 ? 'error' : 'info'))); }
  finally { await c.stop(); }
  assert.equal(f.job.logs.length, 1000); assert.equal(f.job.logCollection.dropped, 100);
  const page = logPage(f.job, { level: 'error', limit: 2 });
  assert.equal(page.filteredTotal, 500); assert.equal(page.nextOffset, 2); assert.equal(page.entries.length, 2);
  assert.equal(JSON.stringify(page).includes('private-value'), false); assert.equal(JSON.stringify(page).includes('TEST-SERIAL'), false);
  assert.throws(() => logPage(f.job, { offset: -1 }), /分页/); assert.throws(() => logPage(f.job, { limit: 1001 }), /分页/);
  assert.equal(redactLog('password="some password"'), 'password=[redacted]');
  const now = Date.UTC(2027, 0, 1); assert.ok(logTime('01-01 00:00:01', now) > logTime('12-31 23:59:59', now));
});
test('只装 dshE2E 时日志与历史可用；设备采集和查询给出缺 Harmony 的明确提示', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-alone-'));
  const service = createService({}, root);
  try {
    const status = await service.status({ sessionId: 'unit' });
    assert.equal(status.harmonyReady, false);
    assert.deepEqual(status.devices, []);
    assert.equal(status.format, 'validation-v1');
    await assert.rejects(() => service.startCapture({ serial: 'TEST', logAppBundle: 'test.app' }, { sessionId: 'unit' }), /需要 dshHarmony/);
    await assert.rejects(() => service.resolveApp('测试'), /需要 dshHarmony/);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});
test('AI 工具读取日志正文；旧执行操作返回迁移说明而不是执行', async () => {
  let tool, options;
  const ctx = { effect(fn) { fn(); }, tools: { register(t) { tool = t; } }, systemPrompt: { section() {} }, dshE2E: {
    validation: {},
    async getLogs(id, o) { options = o; return { id, entries: [entry(1, '10-12 01:00:01', '正文')] }; },
  } };
  apply(ctx); const exec = { signal: AbortSignal.timeout(2000), agent: { id: 'test' } };
  const logs = await tool.execute({ operation: 'get_logs', id: 'run', level: 'error', limit: 2 }, exec);
  assert.equal(logs.entries[0].message, '正文'); assert.equal(options.level, 'error'); assert.equal(options.limit, 2);
  await assert.rejects(() => tool.execute({ operation: 'run', goal: '旧调用' }, exec), /已移除|内层执行器/);
  await assert.rejects(() => tool.execute({ operation: 'replay', id: 'run' }, exec), /回放已移除/);
  await assert.rejects(() => tool.execute({ operation: 'cancel', id: 'run' }, exec), /取消已移除|已退役/);
});
