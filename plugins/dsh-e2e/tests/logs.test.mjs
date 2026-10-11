import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.throws(() => logPage(f.job, { offset: -1 }), /分页/); assert.throws(() => logPage(f.job, { limit: 300 }), /分页/);
  assert.equal(redactLog('password="some password"'), 'password=[redacted]');
  const now = Date.UTC(2027, 0, 1); assert.ok(logTime('01-01 00:00:01', now) > logTime('12-31 23:59:59', now));
});
test('默认缺日志目标在操作前失败；resolve_app 返回真实设备候选', async () => {
  let inputs = 0;
  const m = { async listDevices() { return [{ serial: 'TEST', state: 'online', capabilities: { tap: true, uiTree: true } }]; }, async acquireLease() { inputs++; }, async applications() { return [{ bundleName: 'test.app', label: '测试' }]; } };
  const service = createService({ dshHarmony: { automation: { getManager: () => m } } });
  try {
    const run = await service.run({ goal: '检查界面', expectation: '界面可见', name: `missing-log-target-${Date.now()}` }, 'test', {});
    assert.equal(run.status, 'failed'); assert.equal(inputs, 0); assert.equal(run.logCollection.status, 'unresolved');
    assert.equal(run.diagnostics.entries.length, 0); assert.equal((await service.resolveApp('测试')).resolved, 'test.app');
  } finally { await service.dispose(); }
});
test('AI 工具直接收到日志正文，get_logs 保留筛选参数', async () => {
  let tool, options;
  const ctx = { effect(fn) { fn(); }, tools: { register(t) { tool = t; } }, systemPrompt: { section() {} }, dshE2E: {
    async get() { return { id: 'run' }; }, summary() { return { id: 'run', status: 'passed' }; },
    async getDiagnostics() { return { entries: [entry(1, '10-12 01:00:01', '错误详情', 'error')] }; },
    async getLogs(id, o) { options = o; return { id, entries: [entry(1, '10-12 01:00:01', '正文')] }; },
  } };
  apply(ctx); const exec = { signal: AbortSignal.timeout(2000) };
  const report = await tool.execute({ operation: 'get_report', id: 'run' }, exec);
  assert.equal(report.diagnostics.entries[0].message, '错误详情');
  const logs = await tool.execute({ operation: 'get_logs', id: 'run', level: 'error', limit: 2 }, exec);
  assert.equal(logs.entries[0].message, '正文'); assert.equal(options.level, 'error'); assert.equal(options.limit, 2);
});
