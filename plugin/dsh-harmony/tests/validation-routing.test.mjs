import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRouting, isMutating, isObservation, taskRoutingGuidance } from '../src/task-routing.ts';
import { createValidationBridge, structuredHarmonyError, structuredToolFailure, humanObserve } from '../src/validation-bridge.ts';

test('人工模式禁止控制动作，只读观察放行；没有轮次时不阻断普通 Harmony 调用', () => {
  const routing = createTaskRouting();
  const registered = routing.register({ activeAttempt: sessionId => sessionId === 'human' ? { taskId: 't1', attemptId: 'a1', mode: 'human', serial: 'SN1' } : sessionId === 'ai' ? { taskId: 't2', attemptId: 'a2', mode: 'ai', serial: 'SN1' } : null });
  assert.equal(routing.enabled, true);
  assert.deepEqual(routing.check('none', { operation: 'tap_ref' }), { attempt: null, humanMode: false, mutating: true });
  const decision = routing.check('ai', { operation: 'tap_ref' });
  assert.equal(decision.humanMode, false); assert.equal(decision.mutating, true);
  assert.throws(() => routing.check('human', { operation: 'tap_ref' }), /HUMAN_MODE_READ_ONLY/);
  assert.throws(() => routing.check('human', { operation: 'prepare_device' }), /HUMAN_MODE_READ_ONLY/);
  assert.doesNotThrow(() => routing.check('human', { operation: 'observe_page' }));
  assert.doesNotThrow(() => routing.check('human', { operation: 'read_logs' }));
  registered();
  assert.equal(routing.enabled, false);
  assert.equal(isMutating('input_text'), true);
  assert.equal(isObservation('take_screenshot'), true);
});

test('路由提示词不再强制 e2e_phone.run', () => {
  assert.equal(/必须从 e2e_phone\.run 开始|E2E_REQUIRED/.test(taskRoutingGuidance), false);
  assert.match(taskRoutingGuidance, /唯一的设备执行与观察层/);
  assert.match(taskRoutingGuidance, /人工模式/);
  assert.match(taskRoutingGuidance, /不要自动重发/);
});

test('结构化错误保留 code/details/派发状态，不压成纯文本', () => {
  const error = Object.assign(new Error('命令超时'), { code: 'COMMAND_TIMEOUT', details: { dispatchState: 'unknown', stage: 'dispatch' }, retryable: true });
  const structured = structuredHarmonyError(error);
  assert.equal(structured.code, 'COMMAND_TIMEOUT');
  assert.equal(structured.dispatchState, 'unknown');
  assert.equal(structured.stage, 'dispatch');
  assert.equal(structured.retryable, true);
  const fromTool = structuredToolFailure({ isError: true, details: { error: { code: 'DEVICE_BUSY', message: '占用', details: { dispatchState: 'not-sent', effect: 'not-applied', verification: 'failed' } } } });
  assert.equal(fromTool.code, 'DEVICE_BUSY');
  assert.equal(fromTool.dispatchState, 'not-sent');
  assert.equal(fromTool.effect, 'not-applied');
  assert.equal(fromTool.verification, 'failed');
  assert.equal(structuredToolFailure({ details: {} }).code, 'TOOL_FAILED');
});

test('人工模式观察不申请控制租约：snapshot 不带 leaseToken，事件标记 not-sent', async () => {
  const calls = [];
  const manager = {
    async snapshot(options) { calls.push(options); return { nodes: [{ ref: 'r', type: 'Text', text: '首页', bounds: { left: 0, top: 0, right: 10, bottom: 10 } }], quality: { treeStatus: 'valid', scopeComplete: true }, viewport: { width: 1080, height: 2400 }, generation: 4, revision: 2, capturedAt: '2026-10-18T00:00:00.000Z' }; },
    async getDisplayGeometry() { return { nativeWidth: 1080, nativeHeight: 2400, orientation: 'portrait' }; },
  };
  const observed = await humanObserve(manager, { serial: 'SN1', operation: 'observe_page', includeScreenshot: true });
  assert.equal('leaseToken' in calls[0], false, '只读观察不能携带控制租约');
  assert.equal(observed.details.humanMode, true);
  assert.equal(observed.details.leaseAcquired, false);
  assert.equal(observed.details.dispatchState, 'not-sent');
  assert.equal(observed.content[0].type, 'text');
  assert.equal(observed.content.length, 1, '没有截图时不伪造图片块');
  assert.equal(JSON.parse(observed.content[0].text).humanMode, true);
});

test('事件桥：未安装 dshE2E 时明确未记录；有服务时写入绑定的 start/end', async () => {
  const absent = createValidationBridge(() => undefined);
  assert.deepEqual(await absent.begin('s', { callId: 'c1', operation: 'tap_ref', humanMode: false }), { recorded: false, context: null, reason: '未安装 dshE2E，本次调用没有创建验证记录' });
  assert.equal(absent.attemptContext('s'), null);

  const events = [];
  const context = { taskId: 't1', attemptId: 'a1', mode: 'ai', serial: 'SN1' };
  const service = {
    attemptContext: () => context,
    async recordToolEvent(sessionId, bound, event) { events.push({ sessionId, bound, event }); return { recorded: true, seq: events.length }; },
    async saveEvidence() { return { name: 'ev-1.png', eventId: 'ev-1' }; },
  };
  const bridge = createValidationBridge(() => service);
  const started = await bridge.begin('s', { callId: 'c1', operation: 'tap_ref', input: { text: '输入', ref: 'r1', generation: 2, token: 'abc', note: 'password=hunter2' }, humanMode: false });
  assert.equal(started.recorded, true);
  assert.equal(started.context.attemptId, 'a1');
  await bridge.end('s', started.context, { callId: 'c1', operation: 'tap_ref', result: { details: { action: 'tap_ref', dispatchState: 'sent', effect: 'unknown' } }, humanMode: false });
  assert.equal(events.length, 2);
  assert.equal(events[0].event.type, 'tool-start');
  assert.equal(events[0].event.data.operation, 'tap_ref');
  assert.equal(events[1].bound.attemptId, 'a1', 'end 必须写回 begin 固定的轮次');
  assert.equal(JSON.stringify(events[0].event).includes('hunter2'), false, '敏感输入被裁剪');
  assert.equal(JSON.stringify(events[0].event).includes('"abc"'), false, 'token 字段被裁剪');
  assert.equal(events[1].event.dispatchState, 'sent');
  assert.equal(events[1].event.effect, 'unknown');
});

test('记录失败时上报未记录，供调用方在派发前中止', async () => {
  const service = {
    attemptContext: () => ({ taskId: 't', attemptId: 'a', mode: 'ai', serial: 'SN1' }),
    async recordToolEvent() { throw new Error('disk full'); },
    async saveEvidence() { throw new Error('disk full'); },
  };
  const bridge = createValidationBridge(() => service);
  const result = await bridge.begin('s', { callId: 'c', operation: 'tap_ref', humanMode: false });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'disk full');
  assert.equal(result.context.attemptId, 'a');
});