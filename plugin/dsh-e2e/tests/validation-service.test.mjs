import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createValidationService } from '../src/validation-service.mjs';
import { validationReportView, validationTimeline } from '../src/presentation.mjs';

const legacy = { format: 'legacy-e2e-v1', async list() { return []; } };

function fakeManager(initial = {}) {
  const state = { processes: initial.processes || [], bundles: initial.bundles || [{ bundleName: 'com.demo.app', label: 'Demo', process: 'com.demo.app' }], sink: undefined };
  return {
    state,
    applications: async () => state.bundles,
    listProcesses: async () => state.processes,
    readLogs: async () => [],
    streamLogs: async (_serial, accept, signal) => {
      state.sink = accept;
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    },
    listDevices: async () => [{ serial: 'SN1', state: 'online' }],
    emit(entries) { state.sink?.(entries); },
  };
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-service-'));
  const manager = fakeManager();
  const service = createValidationService({ root, legacy, managerFor: () => manager });
  try { await run({ root, service, manager }); }
  finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
}

async function readyTask(service, sessionId = 's', serial = 'SN1') {
  await service.saveTask(sessionId, { taskId: 'task-aaaaaaaa', title: '崩溃', kind: 'bug', requirement: '启动崩溃', checkpoints: [{ id: 'cp1', description: '首页可见' }] });
  return service.beginValidation(sessionId, { taskId: 'task-aaaaaaaa', mode: 'ai', serial, installationConfirmed: true });
}

test('开始验证必须显式确认安装或验现有安装；同一会话只允许一个进行中轮次', () => fixture(async ({ service }) => {
  await service.saveTask('s', { taskId: 'task-aaaaaaaa', title: '崩溃', kind: 'bug', requirement: '启动崩溃', checkpoints: [{ id: 'cp1', description: '首页可见' }] });
  await assert.rejects(() => service.beginValidation('s', { taskId: 'task-aaaaaaaa', mode: 'ai', serial: 'SN1' }), /已确认安装|验当前已安装/);
  await assert.rejects(() => service.beginValidation('s', { taskId: 'task-aaaaaaaa', mode: 'ai', serial: 'SN1', installationConfirmed: true, verifyExisting: true }), /只能选一项/);
  const attempt = await service.beginValidation('s', { taskId: 'task-aaaaaaaa', mode: 'ai', serial: 'SN1', installationConfirmed: true });
  assert.equal(attempt.contextRevision, 'task-aaaaaaaa@1');
  await assert.rejects(() => service.beginValidation('s', { taskId: 'task-aaaaaaaa', mode: 'ai', serial: 'SN1', installationConfirmed: true }), /已有进行中的验证轮次/);
}));

test('运行中的采集报告使用实时状态与计数，停止后仍可从持久记录读取', () => fixture(async ({ service, manager }) => {
  const attempt = await readyTask(service);
  const capture = await service.startCapture('s', { taskId: attempt.taskId, attemptId: attempt.attemptId, serial: 'SN1', logAppBundle: 'com.demo.app' });
  manager.emit([{ pid: 101, level: 'info', tag: 'com.demo.app', message: 'com.demo.app live capture evidence' }]);
  const live = await service.readValidation('s', { taskId: attempt.taskId, attemptId: attempt.attemptId });
  const row = live.captures.find(item => item.captureId === capture.captureId);
  assert.equal(row.status, 'capturing');
  assert.equal(row.integrity, 'collecting');
  assert.equal(row.retained, 1);
  assert.equal((await service.captures('s', attempt.taskId, attempt.attemptId))[0].status, 'capturing');
  await service.stopCapture('s', { captureId: capture.captureId });
  const stopped = (await service.captures('s', attempt.taskId, attempt.attemptId))[0];
  assert.equal(stopped.status, 'captured');
  assert.equal(stopped.persisted, 1);
  assert.equal((await service.captureRecords('other', attempt.taskId, attempt.attemptId)).length, 0);
}));

test('跨会话同设备互斥；结束后释放设备', () => fixture(async ({ service }) => {
  await readyTask(service, 's1', 'SN1');
  await service.saveTask('s2', { taskId: 'task-bbbbbbbb', title: '功能', kind: 'feature', requirement: '新功能', checkpoints: [{ id: 'cp1', description: '可见' }] });
  await assert.rejects(() => service.beginValidation('s2', { taskId: 'task-bbbbbbbb', mode: 'ai', serial: 'SN1', installationConfirmed: true }), /另一个会话的验证轮次/);
  const attempt = service.activeAttempt('s1');
  await service.finishValidation('s1', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId });
  const second = await service.beginValidation('s2', { taskId: 'task-bbbbbbbb', mode: 'ai', serial: 'SN1', installationConfirmed: true });
  assert.equal(second.attemptId.startsWith('attempt-'), true);
}));

test('人工声明与自动派发分开：AI 轮次不能写人工来源，人工轮次不接受 ai 来源', () => fixture(async ({ service }) => {
  const attempt = await readyTask(service);
  await assert.rejects(() => service.recordCheckpoint('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, checkpointId: 'cp1', result: 'pass', source: 'human' }), /AI 模式不能把工具结果记成人工声明/);
  const recorded = await service.recordCheckpoint('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, checkpointId: 'cp1', result: 'unverified', summary: '未观察到' });
  assert.equal(recorded.checkpointSummary.unverified, 1);
}));

test('必验项未完成不能宣告整体通过；结束后拒绝新记录', () => fixture(async ({ service }) => {
  const attempt = await readyTask(service);
  await assert.rejects(() => service.finishValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, overall: 'passed' }), /不能宣告整体通过/);
  const finished = await service.finishValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId });
  assert.equal(finished.semantic, 'incomplete');
  const again = await service.finishValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId });
  assert.equal(again.execution, 'finished', 'finish 必须幂等');
  await assert.rejects(() => service.recordCheckpoint('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, checkpointId: 'cp1', result: 'pass' }), (error) => error.code === 'ATTEMPT_CLOSED');
  const afterFinish = await service.finishValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId });
  assert.equal(afterFinish.execution, 'finished', '重复 finish 幂等返回，不新增结论');
}));

test('全部必验项通过才 passed；失败项单独体现', () => fixture(async ({ service }) => {
  const attempt = await readyTask(service);
  await service.store.writeEvidence('s', 'task-aaaaaaaa', attempt.attemptId, 'ev-pass.png', Buffer.from('png'));
  await service.recordCheckpoint('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, checkpointId: 'cp1', result: 'pass', evidence: ['ev-pass.png'] });
  const finished = await service.finishValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId });
  assert.equal(finished.semantic, 'passed');
  assert.equal(finished.logIntegrity, 'not-collected');
  assert.equal(finished.cleanup, 'released');
}));

test('取消幂等并保留既有事实；之后拒绝记录', () => fixture(async ({ service }) => {
  const attempt = await readyTask(service);
  await service.recordCheckpoint('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, checkpointId: 'cp1', result: 'fail', summary: '崩溃复现' });
  const cancelled = await service.cancelValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, reason: '用户取消' });
  assert.equal(cancelled.execution, 'cancelled');
  assert.equal(cancelled.checkpoints[0].result, 'fail');
  const again = await service.cancelValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId });
  assert.equal(again.execution, 'cancelled');
  await assert.rejects(() => service.recordCheckpoint('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, checkpointId: 'cp1', result: 'pass' }), (error) => error.code === 'ATTEMPT_CLOSED');
}));

test('Harmony 事件写回原轮次；没有轮次时不伪造成验证记录', () => fixture(async ({ service }) => {
  assert.deepEqual(await service.recordHostEvent('s', { type: 'tool-start' }), { recorded: false, reason: '当前会话没有进行中的验证轮次，本次调用没有创建验证记录' });
  const attempt = await readyTask(service);
  const start = await service.recordHostEvent('s', { type: 'tool-start', callId: 'call-1', operationId: 'op-1', data: { operation: 'tap' }, dispatchState: 'not-sent' });
  assert.equal(start.recorded, true);
  assert.equal(start.seq, 2, 'attempt-started 是第 1 条');
  const end = await service.recordHostEvent('s', { type: 'tool-end', callId: 'call-1', dispatchState: 'sent', effect: 'unknown', verification: 'not-run', error: { code: 'COMMAND_TIMEOUT', dispatchState: 'unknown' } });
  assert.equal(end.recorded, true);
  const read = await service.readValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, afterSeq: 0, limit: 10 });
  assert.deepEqual(read.events.events.map(event => event.type), ['attempt-started', 'tool-start', 'tool-end']);
  assert.equal(read.events.events[2].error.code, 'COMMAND_TIMEOUT');
}));

test('报告视图兼容既有历史面板字段；未采集指标不伪零，事件可作时间线', () => fixture(async ({ service }) => {
  const attempt = await readyTask(service);
  await service.store.writeEvidence('s', 'task-aaaaaaaa', attempt.attemptId, 'ev-report.png', Buffer.from('png'));
  await service.recordCheckpoint('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, checkpointId: 'cp1', result: 'pass', evidence: ['ev-report.png'] });
  await service.finishValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId });
  const read = await service.readValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, limit: 100 });
  const task = await service.readValidation('s', { taskId: 'task-aaaaaaaa' });
  const timeline = validationTimeline(task, read.attempt, read.events.events);
  const view = validationReportView(task, read.attempt, timeline);
  assert.equal(view.totals.modelCalls, '未采集', '没有采集就不显示 0 次');
  assert.deepEqual(view.cache, []);
  assert.equal(Array.isArray(view.steps), true);
  assert.equal(view.steps.every(step => typeof step.label === 'string' && step.label.length), true);
  assert.equal(view.logCollection.status, 'unresolved');
  assert.equal(Array.isArray(view.checkpoints), true);
  assert.equal(view.validation.events.some(event => event.type === 'checkpoint-recorded'), true);
}));


test('采集不绑定调用方 signal：跨 AI 回复继续，会话关闭时才停止', () => fixture(async ({ service, manager }) => {
  manager.state.processes = [{ pid: 100, name: 'com.demo.app' }];
  const attempt = await readyTask(service);
  const callerSignal = new AbortController();
  const capture = await service.startCapture('s', { serial: 'SN1', logAppBundle: 'com.demo.app', taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, signal: callerSignal.signal });
  callerSignal.abort(new Error('本轮结束'));
  manager.emit([{ pid: 100, tag: 'com.demo.app', message: 'turn-2', level: 'info', timestamp: '10-18 10:00:02' }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const disposed = await service.disposeSession('s');
  assert.deepEqual(disposed.stoppedCaptures, [capture.captureId]);
  const events = await service.readValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId, limit: 100 });
  assert.equal(events.attempt.execution, 'interrupted', '会话关闭把进行中轮次标记中断，不自动继续');
  assert.equal(events.events.events.some(event => event.type === 'attempt-interrupted'), true);
}));

test('CaptureSession 独立采集与停止；只保留目标应用条目并写入归档元数据', () => fixture(async ({ root, service, manager }) => {
  manager.state.processes = [{ pid: 100, name: 'com.demo.app' }];
  const attempt = await readyTask(service);
  const capture = await service.startCapture('s', { serial: 'SN1', logAppBundle: 'com.demo.app', taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId });
  assert.equal(capture.status, 'starting');
  manager.emit([{ pid: 100, tag: 'com.demo.app', message: 'boom', level: 'error', timestamp: '10-18 10:00:00' }]);
  manager.emit([{ pid: 999, tag: 'other.app', message: 'ignored', level: 'info', timestamp: '10-18 10:00:01' }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const stopped = await service.stopCapture('s', { captureId: capture.captureId });
  assert.equal(stopped.retained, 1, '只保留目标应用条目');
  assert.equal(['captured', 'empty', 'partial', 'unconfirmed'].includes(stopped.status), true);
  assert.equal(stopped.integrity === 'complete' || stopped.integrity === 'partial', true);
  const dir = join(root, 'validation-v1', 'sessions');
  const sessions = await readdir(dir);
  assert.equal(sessions.length, 1);
  const attemptRead = await service.readValidation('s', { taskId: 'task-aaaaaaaa', attemptId: attempt.attemptId });
  assert.equal(attemptRead.events.events.some(event => event.type === 'capture-stopped'), true);
  const meta = JSON.parse(await readFile(join(dir, sessions[0], 'tasks', 'task-aaaaaaaa', 'attempts', attempt.attemptId, 'logs', 'captures', capture.captureId, 'app-logs.meta.json'), 'utf8'));
  assert.equal(meta.captureId, capture.captureId, '采集归属写入自己的归档元数据');
}));
