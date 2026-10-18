import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/agent.mjs';
import { validateToolCall } from '../src/tool-contract.mjs';

function toolFixture(overrides = {}) {
  let tool, prompt = '';
  const calls = [];
  const validation = {
    async saveTask(sessionId, input) { calls.push(['saveTask', sessionId, input]); return { taskId: 'task-aaaaaaaa', revision: 1, handoffStatus: 'awaiting-install' }; },
    async beginValidation(sessionId, input) { calls.push(['beginValidation', sessionId, input]); return { attemptId: 'attempt-aaaaaaaa', contextRevision: 'task-aaaaaaaa@1' }; },
    async recordCheckpoint(sessionId, input) { calls.push(['recordCheckpoint', sessionId, input]); return { checkpointSummary: { total: 1, pass: 1 } }; },
    async finishValidation(sessionId, input) { calls.push(['finishValidation', sessionId, input]); return { semantic: 'passed' }; },
    async readValidation() { return { tasks: [] }; },
    async cancelValidation() { return { execution: 'cancelled' }; },
    async startCapture() { return { captureId: 'cap-1' }; },
    async stopCapture() { return { captureId: 'cap-1', status: 'captured' }; },
    ...overrides,
  };
  const ctx = {
    effect(fn) { fn(); },
    tools: { register(value) { tool = value; } },
    systemPrompt: { section(value) { prompt = value.text; } },
    dshE2E: {
      validation,
      async resolveApp(query) { return { query, resolved: 'test.app' }; },
      async listPage() { return { runs: [] }; },
      async getLogs(id) { return { id, entries: [] }; },
      async report() { return { run: { status: 'passed' }, view: {} }; },
    },
  };
  apply(ctx);
  return { tool, calls, prompt: () => prompt, exec: { agent: { id: 'unit' }, callId: 'call-1', signal: new AbortController().signal } };
}

test('应用名称别名一致；无操作执行器副作用', async () => {
  const f = toolFixture();
  for (const key of ['name', 'appName', 'query']) assert.equal((await f.tool.execute({ operation: 'resolve_app', [key]: '小艺' }, f.exec)).query, '小艺');
  await assert.rejects(f.tool.execute({ operation: 'resolve_app', query: '小艺', name: 'Work' }, f.exec), /冲突/);
  assert.equal(f.calls.length, 0);
});

test('保存任务与开始验证带会话与 callId，返回操作说明', async () => {
  const f = toolFixture();
  const saved = await f.tool.execute({ operation: 'save_task', title: '崩溃', kind: 'bug', requirement: '启动崩溃', checkpoints: [{ id: 'cp1', description: '首页可见' }] }, f.exec);
  assert.equal(saved.taskId, 'task-aaaaaaaa');
  assert.match(saved.instruction, /等待用户确认/);
  assert.equal(f.calls[0][1], 'unit');
  const began = await f.tool.execute({ operation: 'begin_validation', taskId: 'task-aaaaaaaa', mode: 'human', serial: 'SN1', verifyExisting: true }, f.exec);
  assert.equal(began.attemptId, 'attempt-aaaaaaaa');
  assert.match(began.instruction, /人工模式只允许只读观察/);
  assert.equal(f.calls[1][2].callId, 'call-1');
});

test('记录检查点与结束验证的状态语义透传，不把工具成功说成通过', async () => {
  const f = toolFixture();
  await f.tool.execute({ operation: 'record_checkpoint', taskId: 'task-aaaaaaaa', attemptId: 'attempt-aaaaaaaa', checkpointId: 'cp1', result: 'pass', source: 'ai' }, f.exec);
  assert.equal(f.calls[0][2].callId, 'call-1');
  const finished = await f.tool.execute({ operation: 'finish_validation', taskId: 'task-aaaaaaaa', attemptId: 'attempt-aaaaaaaa' }, f.exec);
  assert.equal(finished.semantic, 'passed');
  assert.match(finished.instruction, /证据不全时不能宣告通过/);
});

test('旧执行操作给出迁移错误，且不调用任何验证方法', async () => {
  const f = toolFixture();
  for (const [args, pattern] of [
    [{ operation: 'run', goal: '返回桌面' }, /内层执行器已移除/],
    [{ operation: 'replay', id: 'x' }, /动作回放已移除/],
    [{ operation: 'retry', id: 'x' }, /复测执行器已移除/],
    [{ operation: 'cancel', id: 'x' }, /运行取消已移除/],
    [{ operation: 'archive', id: 'x', archived: true }, /归档已退役/],
  ]) {
    await assert.rejects(f.tool.execute(args, f.exec), pattern);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => validateToolCall({ operation: 'run', goal: 'x', milliseconds: 1 }), /不接受字段/);
});

test('提示词不再强制 e2e_phone.run 或内层独立验收', () => {
  const f = toolFixture();
  const prompt = f.prompt();
  assert.equal(/必须先用 e2e_phone\.run/.test(prompt), false);
  assert.equal(/E2E_REQUIRED/.test(prompt), false);
  assert.match(prompt, /不再有内层 AI 循环|不再有内层AI循环/);
  assert.match(prompt, /人工模式|mode:human/);
  assert.match(prompt, /旧格式未记录/);
});
