// Regression checks for the independent source review (R01–R13).
// Source-only fixtures with a fake device manager; no build, install or phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createValidationService } from '../src/validation-service.mjs';
import { createService } from '../src/service.mjs';
import { createLegacyReader } from '../src/legacy.mjs';
import { createValidationBridge, humanObserve } from '../../dsh-harmony/src/validation-bridge.ts';

function fakeManager() {
  const state = { callbacks: [], calls: [], processes: [{ pid: 101, name: 'com.demo.app' }] };
  return {
    state,
    async applications(serial) { state.calls.push(['applications', serial]); return [{ bundleName: 'com.demo.app', label: 'fixture' }]; },
    async listDevices() { return [{ serial: 'SN1', state: 'online', name: 'SN1' }, { serial: 'SN2', state: 'online', name: 'SN2' }]; },
    async listProcesses(serial) { state.calls.push(['listProcesses', serial]); return state.processes; },
    async readLogs() { return []; },
    streamLogs(serial, callback, signal) {
      state.calls.push(['streamLogs', serial]); state.callbacks.push(callback);
      callback([{ pid: 101, tag: 'com.demo.app', message: 'fixture-only-log', level: 'info' }]);
      return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
}

async function fixture(name = 'fixture') {
  const root = await mkdtemp(join(tmpdir(), `dsh-review-${name}-`));
  const manager = fakeManager();
  const service = createValidationService({ root, legacy: createLegacyReader(root), managerFor: () => manager });
  return { root, manager, service };
}
async function saveTask(service, session = 's') {
  return service.saveTask(session, { title: 'fixture task', requirement: 'review', checkpoints: [{ id: 'cp1', description: 'one' }, { id: 'cp2', description: 'two' }] });
}
async function begin(service, taskId, session = 's', serial = 'SN1') {
  return service.beginValidation(session, { taskId, serial, mode: 'ai', verifyExisting: true });
}
async function passWithEvidence(service, taskId, attemptId, checkpointId = 'cp1') {
  await service.store.writeEvidence('s', taskId, attemptId, `ev-${checkpointId}.png`, Buffer.from('png'));
  return service.recordCheckpoint('s', { taskId, attemptId, checkpointId, result: 'pass', evidence: [`ev-${checkpointId}.png`] });
}

test('R01：任务与轮次都进入会话列表；报告顶层满足面板契约', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r01-'));
  const service = createService({}, root);
  try {
    await service.status({ sessionId: 's' });
    const task = await service.validation.saveTask('s', { title: '等待安装', requirement: 'r', checkpoints: [{ id: 'cp1', description: 'one' }] });
    let page = await service.listPage({ sessionId: 's', offset: 0, limit: 20 });
    assert.equal(page.total, 1, '没有 attempt 的任务必须可见');
    assert.equal(page.runs[0].status, 'draft');
    assert.equal(page.runs[0].sessionId, 's');
    const attempt = await service.validation.beginValidation('s', { taskId: task.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true });
    const id = `${task.taskId}/${attempt.attemptId}`;
    page = await service.listPage({ sessionId: 's', offset: 0, limit: 20 });
    assert.equal(page.total, 1, '有轮次的任务由轮次行表示，不重复列出任务');
    assert.equal(page.runs.some(row => row.id === id && row.sessionId === 's' && row.status === 'running'), true);
    const report = await service.report(id, { sessionId: 's' });
    assert.equal(report.run.id, id);
    assert.equal(report.run.status, 'running');
    assert.equal(report.run.name, '等待安装');
    assert.equal(report.run.sessionId, 's');
    assert.equal(typeof report.run.createdAt, 'string');
    assert.equal(Array.isArray(report.view.steps), true);
    const taskReport = await service.report(task.taskId, { sessionId: 's' });
    assert.equal(taskReport.run.kind, 'task');
    assert.equal(taskReport.run.attempts.length, 1);
    await assert.rejects(() => service.report(id, { sessionId: 'other' }), /找不到该任务/);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('R02：新旧日志都返回分页 entries，旧格式保持 LogViewer 契约', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r02-'));
  const manager = fakeManager();
  const service = createService({ dshHarmony: { automation: { getManager: () => manager } } }, root);
  try {
    await service.status({ sessionId: 's' });
    const flowId = 'a'.repeat(24), legacyId = '11111111-1111-1111-1111-111111111111';
    const directory = join(root, 'workflows', flowId, 'runs', legacyId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'record.json'), JSON.stringify({ fl: flowId, flowId, id: legacyId, sessionId: 's', status: 'passed', createdAt: '2026-10-18T00:00:00Z' }));
    await writeFile(join(directory, 'app-logs.jsonl'), JSON.stringify({ message: 'legacy line', level: 'info' }) + '\n');
    const legacy = await service.getLogs(legacyId, { offset: 0, limit: 10 }, { sessionId: 's' });
    assert.equal(Array.isArray(legacy.entries), true);
    assert.equal(legacy.entries[0].message, 'legacy line');

    const task = await service.validation.saveTask('s', { title: 'capture', requirement: 'r', checkpoints: [{ id: 'cp1', description: 'one' }] });
    const attempt = await service.validation.beginValidation('s', { taskId: task.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true });
    const capture = await service.validation.startCapture('s', { serial: 'SN1', taskId: task.taskId, attemptId: attempt.attemptId, logAppBundle: 'com.demo.app' });
    await service.validation.stopCapture('s', { captureId: capture.captureId });
    const id = `${task.taskId}/${attempt.attemptId}`;
    const page = await service.getLogs(id, { offset: 0, limit: 10 }, { sessionId: 's' });
    assert.equal(Array.isArray(page.entries), true);
    assert.equal(page.entries.length >= 1, true);
    assert.equal(page.entries[0].message, 'fixture-only-log');
    assert.equal(page.nextOffset, null);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('R03：零证据、空集合覆盖、重复检查点都被拒绝', async () => {
  const { root, service } = await fixture('r03');
  try {
    const task = await saveTask(service);
    const attempt = await begin(service, task.taskId);
    await assert.rejects(() => service.recordCheckpoint('s', { taskId: task.taskId, attemptId: attempt.attemptId, checkpointId: 'cp1', result: 'pass' }), /必须引用证据/);
    await service.cancelValidation('s', { taskId: task.taskId, attemptId: attempt.attemptId });
    const shrunk = await service.beginValidation('s', { taskId: task.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true, checkpoints: [] });
    assert.equal(shrunk.checkpoints.length, 2, '显式空列表不能缩减任务既定的必验项');
    await service.cancelValidation('s', { taskId: task.taskId, attemptId: shrunk.attemptId });
    await assert.rejects(() => service.saveTask('s', { title: 'dup', requirement: 'r', checkpoints: [{ id: 'cp1', description: 'a' }, { id: 'cp1', description: 'b' }] }), /重复/);
    const empty = await service.saveTask('s', { title: 'no checks', requirement: 'r', checkpoints: [] });
    await assert.rejects(() => begin(service, empty.taskId), /没有可验证的检查点/);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('R06：取消后的迟到回执写入原轮次，不串到新轮次', async () => {
  const { root, service } = await fixture('r06');
  try {
    const task = await saveTask(service);
    const a = await begin(service, task.taskId);
    const bridge = createValidationBridge(() => service);
    const started = await bridge.begin('s', { callId: 'old-call', operation: 'tap', humanMode: false });
    assert.equal(started.recorded, true);
    const cancelled = await service.cancelValidation('s', { taskId: task.taskId, attemptId: a.attemptId });
    assert.equal(cancelled.cleanup, 'pending', '有未结束调用时清理保持 pending');
    await assert.rejects(() => begin(service, task.taskId), /设备|进行中/, 'pending 清理期间设备仍有占位');
    const ended = await bridge.end('s', started.context, { callId: 'old-call', operation: 'tap', humanMode: false, result: { details: { dispatchState: 'sent' } } });
    assert.equal(ended.recorded, true);
    assert.equal(ended.late, true);
    const settled = await service.resolveCleanup('s', { taskId: task.taskId, attemptId: a.attemptId });
    assert.equal(settled.cleanup, 'released', '迟到回执收敛后释放设备占位');
    const b = await begin(service, task.taskId);
    const newData = await service.readValidation('s', { taskId: task.taskId, attemptId: b.attemptId });
    assert.equal(newData.events.events.some(event => event.callId === 'old-call'), false, '旧调用的回执不能写进新轮次');
    const oldData = await service.readValidation('s', { taskId: task.taskId, attemptId: a.attemptId });
    assert.equal(oldData.events.events.some(event => event.type === 'tool-end-late' && event.callId === 'old-call'), true);
    // Context-less receipts must not fall back to "whatever session is active".
    const orphan = await bridge.end('s', null, { callId: 'unknown-call', operation: 'tap', humanMode: false, result: { details: {} } });
    assert.equal(orphan.recorded, false);
    const stillClean = await service.readValidation('s', { taskId: task.taskId, attemptId: b.attemptId });
    assert.equal(stillClean.events.events.some(event => event.callId === 'unknown-call'), false);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('R07：并发 begin 只有一个成功，并行检查点不丢更新', async () => {
  const { root, service } = await fixture('r07');
  try {
    const task = await saveTask(service);
    const results = await Promise.allSettled([begin(service, task.taskId), begin(service, task.taskId)]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter(item => item.status === 'rejected').length, 1);
    const attempts = await service.store.listAttempts('s', task.taskId);
    assert.equal(attempts.filter(item => item.execution === 'active').length, 1);
    const active = attempts.find(item => item.execution === 'active');
    await Promise.all(['cp1', 'cp2'].map(checkpointId => service.recordCheckpoint('s', { taskId: task.taskId, attemptId: active.attemptId, checkpointId, result: 'fail' })));
    const data = await service.readValidation('s', { taskId: task.taskId, attemptId: active.attemptId });
    assert.deepEqual(data.attempt.checkpoints.map(item => item.result), ['fail', 'fail']);
    assert.equal(data.events.events.filter(event => event.type === 'checkpoint-recorded').length, 2);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('R04/R08/R11：采集不覆盖、独立采集持久、终结轮次拒绝采集、设备绑定与预算生效', async () => {
  const { root, manager, service } = await fixture('r04');
  try {
    const task = await saveTask(service);
    const attempt = await begin(service, task.taskId);
    const options = { serial: 'SN1', taskId: task.taskId, attemptId: attempt.attemptId, logAppBundle: 'com.demo.app', logMaxBytes: 32 * 1024 * 1024 };
    const first = await service.startCapture('s', options);
    manager.state.callbacks[0]([{ pid: 101, tag: 'com.demo.app', message: 'first-only-evidence', level: 'info' }]);
    await service.stopCapture('s', { captureId: first.captureId });
    const archive = join(root, 'validation-v1', 'sessions');
    const [session] = await readdir(archive);
    const firstFile = join(archive, session, 'tasks', task.taskId, 'attempts', attempt.attemptId, 'logs', 'captures', first.captureId, 'app-logs.jsonl');
    const before = await readFile(firstFile, 'utf8');
    assert.match(before, /first-only-evidence/);
    const second = await service.startCapture('s', options);
    await service.stopCapture('s', { captureId: second.captureId });
    assert.equal(await readFile(firstFile, 'utf8'), before, '重启采集不得截断旧证据');
    const meta = JSON.parse(await readFile(join(archive, session, 'tasks', task.taskId, 'attempts', attempt.attemptId, 'logs', 'captures', second.captureId, 'app-logs.meta.json'), 'utf8'));
    assert.equal(meta.maxBytes, 32 * 1024 * 1024, 'logMaxBytes 必须作用于磁盘预算');
    await assert.rejects(() => service.startCapture('s', { ...options, serial: 'SN2' }), /设备不一致/);
    const finished = await service.finishValidation('s', { taskId: task.taskId, attemptId: attempt.attemptId });
    assert.equal(finished.logIntegrity, 'complete', '已停止采集仍计入完整性');
    await assert.rejects(() => service.startCapture('s', { ...options }), /已结束/);
    const standalone = await service.startCapture('s', { serial: 'SN1', logAppBundle: 'com.demo.app' });
    manager.state.callbacks.at(-1)([{ pid: 101, tag: 'com.demo.app', message: 'standalone-evidence', level: 'info' }]);
    const stopped = await service.stopCapture('s', { captureId: standalone.captureId });
    assert.equal(stopped.persisted >= 1, true);
    assert.equal(stopped.integrity, 'complete');
    const standalonePath = join(root, 'validation-v1', 'standalone');
    const files = await readdir(standalonePath, { recursive: true });
    assert.equal(files.some(file => String(file).includes('standalone-evidence') === false && String(file).endsWith('app-logs.jsonl')), true);
    const status = await service.status('s');
    assert.equal(status.captures.some(item => item.captureId === standalone.captureId), true, '独立采集停止后仍可找回');
    const again = await service.stopCapture('s', { captureId: standalone.captureId });
    assert.equal(again.alreadyStopped, true);
    await assert.rejects(() => service.attachCapture('s', { captureId: standalone.captureId, taskId: task.taskId, attemptId: attempt.attemptId }), /进行中/);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('R05：取消中止在途调用信号，清理结论不假成功', async () => {
  const { root, service } = await fixture('r05');
  try {
    const task = await saveTask(service);
    const attempt = await begin(service, task.taskId);
    const signal = service.attemptSignal('s');
    assert.equal(signal.aborted, false);
    await service.recordHostEvent('s', { type: 'tool-start', callId: 'in-flight' });
    const cancelled = await service.cancelValidation('s', { taskId: task.taskId, attemptId: attempt.attemptId });
    assert.equal(signal.aborted, true, '取消必须中止该轮次的在途调用信号');
    assert.equal(cancelled.cleanup, 'pending', '仍有在途调用时不能声称已释放');
    assert.match(cancelled.cleanupNote, /在途/);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('R09：人工观察不完整树不转发节点/图片，敏感值被遮盖并支持分页', async () => {
  const incomplete = { async snapshot() { return { nodes: [{ type: 'TextInput', id: 'password', text: 'private-value' }], quality: { treeStatus: 'unavailable', scopeComplete: false }, screenshot: { data: Buffer.from('not-a-png') } }; } };
  const observed = await humanObserve(incomplete, { serial: 'SN1', operation: 'observe_screen' });
  const payload = JSON.parse(observed.content[0].text);
  assert.equal(payload.complete, false);
  assert.deepEqual(payload.nodes, []);
  assert.equal(observed.content.some(block => block.type === 'image'), false);
  assert.equal(observed.content[0].text.includes('private-value'), false);

  const nodes = Array.from({ length: 5 }, (_, index) => ({ type: 'Text', id: `n${index}`, text: index === 0 ? 'private-value' : `text-${index}`, bounds: { left: 0, top: index, right: 10, bottom: index + 1 } }));
  nodes[0].hint = '密码';
  const complete = { async snapshot() { return { nodes, quality: { treeStatus: 'valid', scopeComplete: true }, viewport: { width: 100, height: 100 }, generation: 2, revision: 1, capturedAt: '2026-10-18T00:00:00Z' }; }, async getDisplayGeometry() { return { nativeWidth: 100, nativeHeight: 100 }; } };
  const page1 = await humanObserve(complete, { serial: 'SN1', operation: 'observe_page', limit: 2 });
  const firstPage = JSON.parse(page1.content[0].text);
  assert.deepEqual(firstPage.nodes.map(node => node.id), ['n0', 'n1']);
  assert.match(firstPage.nextCursor, /^2:1:2:[a-f0-9]{16}$/);
  const page = await humanObserve(complete, { serial: 'SN1', operation: 'observe_page', cursor: firstPage.nextCursor, limit: 2 });
  const first = JSON.parse(page.content[0].text);
  assert.equal(first.complete, true);
  assert.equal(first.total, 5);
  assert.deepEqual(first.nodes.map(node => node.id), ['n2', 'n3']);
  assert.match(first.nextCursor, /^2:1:4:[a-f0-9]{16}$/);
  assert.equal(page.content[0].text.includes('private-value'), false, '敏感文本必须遮盖');
  assert.equal(page.details.leaseAcquired, false);
  // A structured selector must select by id, not by substring of its String().
  const selected = await humanObserve(complete, { serial: 'SN1', operation: 'observe_page', selector: { id: 'n2' } });
  assert.deepEqual(JSON.parse(selected.content[0].text).nodes.map(node => node.id), ['n2']);
});

test('R10：203 个事件的报告明确分页，不静默截断', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r10-'));
  const service = createService({}, root);
  try {
    await service.status({ sessionId: 's' });
    const task = await service.validation.saveTask('s', { title: 'pagination', requirement: 'r', checkpoints: [{ id: 'cp1', description: 'one' }] });
    const attempt = await service.validation.beginValidation('s', { taskId: task.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true });
    for (let index = 0; index < 202; index++) await service.validation.recordHostEvent('s', { type: 'tool-end', callId: `c-${index}` });
    const id = `${task.taskId}/${attempt.attemptId}`;
    const report = await service.report(id, { sessionId: 's' });
    assert.equal(report.diagnostics.events.loaded, 200);
    assert.equal(report.diagnostics.events.total, 203);
    assert.equal(report.diagnostics.events.hasMore, true);
    assert.equal(report.view.validation.hasMore, true);
    assert.equal(report.view.steps.length, 200);
    assert.equal(report.view.totals.modelCalls, '未采集');
    const next = await service.validation.readValidation('s', { taskId: task.taskId, attemptId: attempt.attemptId, afterSeq: report.diagnostics.events.nextAfterSeq, limit: 500 });
    assert.equal(next.events.events.some(event => event.callId === 'c-201'), true);
    assert.equal(next.events.hasMore, false);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('R05/R11：有在途调用或流未确认时，清理与完整性都不假成功', async () => {
  const { root, service } = await fixture('r05b');
  const quiet = await fixture('r11');
  try {
    const task = await saveTask(service);
    const attempt = await begin(service, task.taskId);
    await service.recordHostEvent('s', { type: 'tool-start', callId: 'in-flight' });
    const finished = await service.finishValidation('s', { taskId: task.taskId, attemptId: attempt.attemptId });
    assert.equal(finished.cleanup, 'pending', '结束时有在途调用，不能标 released');
    assert.match(finished.cleanupNote, /在途/);

    quiet.manager.streamLogs = (_serial, _callback, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    const quietTask = await saveTask(quiet.service);
    const quietAttempt = await begin(quiet.service, quietTask.taskId);
    const capture = await quiet.service.startCapture('s', { serial: 'SN1', taskId: quietTask.taskId, attemptId: quietAttempt.attemptId, logAppBundle: 'com.demo.app' });
    const stopped = await quiet.service.stopCapture('s', { captureId: capture.captureId });
    assert.equal(stopped.status, 'unconfirmed');
    assert.equal(stopped.integrity, 'partial', '未确认的流不能标 complete');
  } finally {
    await service.dispose(); await quiet.service.dispose();
    await rm(root, { recursive: true, force: true }); await rm(quiet.root, { recursive: true, force: true });
  }
});

test('R12：证据拒绝覆盖、缺失与父级越界', async () => {
  const { root, service } = await fixture('r12');
  try {
    const task = await saveTask(service);
    const attempt = await begin(service, task.taskId);
    await service.store.writeEvidence('s', task.taskId, attempt.attemptId, 'ev-once.png', Buffer.from('png'));
    await assert.rejects(() => service.store.writeEvidence('s', task.taskId, attempt.attemptId, 'ev-once.png', Buffer.from('other')), /已存在/);
    await assert.rejects(() => service.store.evidencePath('s', task.taskId, attempt.attemptId, 'missing.png'), /找不到/);
    for (const name of ['../x.png', '..\\x.png', 'a/b.png']) await assert.rejects(() => service.store.evidencePath('s', task.taskId, attempt.attemptId, name), /无效/);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});
