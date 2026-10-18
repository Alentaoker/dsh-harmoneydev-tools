// Second-round review regressions (F01–F12). Source-only fixtures: a fake
// manager, registered routes and the real tool schema; no build, install, phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';
import { registerRoutes } from '../src/index.mjs';
import { apply as registerAgent } from '../src/agent.mjs';
import { createValidationBridge, humanObserve } from '../../dsh-harmony/src/validation-bridge.ts';
import sharp from 'sharp';

function fakeManager() {
  const state = { callbacks: [], calls: [], includeScreenshot: [], snapshotCalls: 0, latest: undefined };
  const nodes = Array.from({ length: 5 }, (_, index) => ({ ref: `r${index}`, id: `n${index}`, type: 'Text', text: index === 0 ? 'private-value' : `row-${index}`, hint: index === 0 ? '密码' : undefined, bounds: { left: 0, top: index, right: 10, bottom: index + 1 } }));
  return {
    state,
    async applications(serial) { state.calls.push(['applications', serial]); return [{ bundleName: 'com.demo.app' }]; },
    async listDevices() { return [{ serial: 'SN1', state: 'online' }, { serial: 'SN2', state: 'online' }]; },
    async listProcesses() { return [{ pid: 1, name: 'com.demo.app' }]; },
    async readLogs() { return []; },
    async snapshot(options) {
      state.snapshotCalls++; state.includeScreenshot.push(options.includeScreenshot);
      const snapshot = { serial: options.serial, nodes, quality: { treeStatus: 'valid', scopeComplete: true }, viewport: { width: 100, height: 100 }, generation: 2, revision: 1, capturedAt: new Date().toISOString() };
      if (options.includeScreenshot) snapshot.screenshot = { data: await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#222222' } }).png().toBuffer(), width: 1000, height: 2000 };
      state.latest = snapshot;
      return snapshot;
    },
    getLatestSnapshot() { return state.latest; },
    async getDisplayGeometry() { return { nativeWidth: 1000, nativeHeight: 2000 }; },
    streamLogs(serial, callback, signal) {
      state.callbacks.push(callback);
      callback([{ pid: 1, tag: 'com.demo.app', message: 'fixture-line', level: 'info' }]);
      return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
}

async function fixture(name = 'fixture') {
  const root = await mkdtemp(join(tmpdir(), `dsh-rereview-${name}-`));
  const manager = fakeManager();
  const host = createService({ dshHarmony: { automation: { getManager: () => manager } } }, root);
  await host.status({ sessionId: 's' });
  const task = await host.validation.saveTask('s', { title: 'fixture', requirement: 'r', checkpoints: [{ id: 'cp1', description: 'one' }, { id: 'cp2', description: 'two' }] });
  const started = await host.validation.beginValidation('s', { taskId: task.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true });
  return { root, manager, host, service: host.validation, taskId: task.taskId, attemptId: started.attemptId, id: `${task.taskId}/${started.attemptId}` };
}

test('F02：真实注册路由可下载 attempt/独立采集；导出是合法 NDJSON', async () => {
  const f = await fixture('f02');
  try {
    const attemptCapture = await f.service.startCapture('s', { taskId: f.taskId, attemptId: f.attemptId, logAppBundle: 'com.demo.app' });
    f.manager.state.callbacks[0]([{ pid: 1, tag: 'com.demo.app', message: 'attempt-line-1', level: 'info' }, { pid: 1, tag: 'com.demo.app', message: 'attempt-line-2', level: 'warn' }]);
    await f.service.stopCapture('s', { captureId: attemptCapture.captureId });
    const standalone = await f.service.startCapture('s', { serial: 'SN1', logAppBundle: 'com.demo.app' });
    f.manager.state.callbacks.at(-1)([{ pid: 1, tag: 'com.demo.app', message: 'standalone-line', level: 'info' }]);
    await f.service.stopCapture('s', { captureId: standalone.captureId });

    const routes = new Map();
    registerRoutes({ effect: fn => fn(), connection: { fetch: { register: route => { routes.set(route.path, route); return () => {}; } } } }, f.host);
    const get = async (query) => routes.get('/api/dsh-e2e/validation/capture-file').fetch(new Request('http://fixture/api/dsh-e2e/validation/capture-file?' + query));
    const attemptResponse = await get(`sessionId=s&captureId=${attemptCapture.captureId}&taskId=${f.taskId}&attemptId=${f.attemptId}`);
    assert.equal(attemptResponse.status, 200);
    assert.match(await attemptResponse.text(), /attempt-line-1/);
    const standaloneResponse = await get(`sessionId=s&captureId=${standalone.captureId}`);
    assert.equal(standaloneResponse.status, 200);
    assert.match(await standaloneResponse.text(), /standalone-line/);
    assert.equal((await get(`sessionId=other&captureId=${attemptCapture.captureId}&taskId=${f.taskId}&attemptId=${f.attemptId}`)).status, 404);

    let exported = '';
    for await (const chunk of f.host.captureExport('s', { taskId: f.taskId, attemptId: f.attemptId })) exported += chunk;
    const lines = exported.split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    for (const line of lines) JSON.parse(line);
    assert.equal(exported.endsWith('\n'), true);
    assert.equal(exported.includes('\\n'), false, '导出必须是真实换行');
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F03：观察请求真实截图参数，游标/selector/ancestors 按原契约，分页优先用保留快照', async () => {
  const f = await fixture('f03');
  try {
    const first = await humanObserve(f.manager, { serial: 'SN1', operation: 'observe_screen' });
    assert.equal(f.manager.state.includeScreenshot.at(-1), true, 'observe_screen 必须请求截图');
    assert.equal(first.details._evidence?.data?.length > 0, true);
    assert.equal(first.content.some(block => block.type === 'image'), false, '原始截图不直接交给模型');
    const beforeRetained = f.manager.state.snapshotCalls;
    const page1 = JSON.parse((await humanObserve(f.manager, { serial: 'SN1', operation: 'observe_page', limit: 2 })).content[0].text);
    assert.equal(f.manager.state.snapshotCalls, beforeRetained, '首屏也优先使用保留观察，不打断投屏');
    assert.match(page1.nextCursor, /^2:1:2:[a-f0-9]{16}$/);
    const snapshotCallsBefore = f.manager.state.snapshotCalls;
    const page2 = JSON.parse((await humanObserve(f.manager, { serial: 'SN1', operation: 'observe_page', cursor: page1.nextCursor, limit: 2 })).content[0].text);
    assert.deepEqual(page2.nodes.map(node => node.id), ['n2', 'n3']);
    assert.equal(f.manager.state.snapshotCalls, snapshotCallsBefore, '翻页不得重新 snapshot（避免打断投屏）');
    const selected = JSON.parse((await humanObserve(f.manager, { serial: 'SN1', operation: 'observe_page', selector: { id: 'n2' } })).content[0].text);
    assert.deepEqual(selected.nodes.map(node => node.id), ['n2']);
    const withAncestors = JSON.parse((await humanObserve(f.manager, { serial: 'SN1', operation: 'observe_page', ancestors: true, limit: 1 })).content[0].text);
    assert.equal(Array.isArray(withAncestors.ancestors), true, 'ancestors 是原契约的一部分');
    assert.equal(withAncestors.nodes[0].text.includes('private-value'), false);
    assert.equal(withAncestors.nodes[0].text.includes('[redacted]'), true);
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F04：生命周期事件不能自证通过；schema 接受对象引用；可信观察事件可引用', async () => {
  const f = await fixture('f04');
  try {
    const started = (await f.service.readValidation('s', { taskId: f.taskId, attemptId: f.attemptId })).events.events[0];
    assert.equal(started.type, 'attempt-started');
    await assert.rejects(() => f.service.recordCheckpoint('s', { taskId: f.taskId, attemptId: f.attemptId, checkpointId: 'cp1', result: 'pass', evidence: [{ eventId: started.eventId }] }), /不能自证|可信/);
    let tool;
    registerAgent({ effect: fn => fn(), tools: { register: value => { tool = value; } }, systemPrompt: { section: () => {} } });
    const items = tool.parameters.properties.evidence.items;
    assert.equal(Array.isArray(items.anyOf), true, 'schema 必须同时接受文件名与对象引用');
    assert.deepEqual(items.anyOf[1].properties.callId, { type: 'string' });

    const bridge = createValidationBridge(() => f.service);
    const call = await bridge.begin('s', { callId: 'obs-1', operation: 'observe_screen', humanMode: false });
    const observed = await humanObserve(f.manager, { serial: 'SN1', operation: 'observe_screen' });
    const ended = await bridge.end('s', call.context, { callId: 'obs-1', operation: 'observe_screen', humanMode: false, result: observed, observation: observed.details._evidence });
    assert.equal(ended.recorded, true);
    assert.equal(ended.evidence.length >= 1, true);
    const recorded = await f.service.recordCheckpoint('s', { taskId: f.taskId, attemptId: f.attemptId, checkpointId: 'cp1', result: 'pass', evidence: [{ callId: 'obs-1' }] });
    assert.equal(recorded.checkpoints[0].result, 'pass');
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F05：证据元数据描述实际落盘图片，且可回读同源字节', async () => {
  const f = await fixture('f05');
  try {
    const png = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#333333' } }).png().toBuffer();
    const saved = await f.service.saveEvidence('s', { taskId: f.taskId, attemptId: f.attemptId }, {
      data: png, geometry: { nativeWidth: 1000, nativeHeight: 2000 }, quality: { treeStatus: 'valid', scopeComplete: true },
      nodes: [{ type: 'TextInput', id: 'password', bounds: { left: 0, top: 0, right: 10, bottom: 10 } }], capturedAt: '2026-10-18T00:00:00Z',
    });
    const file = await f.service.evidenceFile('s', f.taskId, f.attemptId, saved.name);
    const actual = await sharp(file).metadata();
    assert.deepEqual({ width: saved.width, height: saved.height }, { width: actual.width, height: actual.height });
    const events = (await f.service.readValidation('s', { taskId: f.taskId, attemptId: f.attemptId })).events.events;
    const event = events.find(item => item.type === 'evidence-saved');
    assert.deepEqual(event.data.displaySize, { width: actual.width, height: actual.height });
    assert.deepEqual(event.data.nativeSize, { width: 1000, height: 2000 });
    assert.equal(event.data.geometryId.startsWith('g-'), true);
    assert.equal(event.data.scale.x, 1000 / actual.width);
    assert.equal(event.data.maskedRegions, 1);
    const bytes = await f.service.readEvidence('s', { taskId: f.taskId, attemptId: f.attemptId, name: saved.name });
    assert.deepEqual(bytes, await readFile(file));
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F06：被拒绝的 finish 不中止轮次；pending 清理保留设备占位', async () => {
  const f = await fixture('f06');
  try {
    const signal = f.service.attemptSignal('s');
    await assert.rejects(() => f.service.finishValidation('s', { taskId: f.taskId, attemptId: f.attemptId, overall: 'passed' }), /不能宣告整体通过/);
    assert.equal(signal.aborted, false, '结论校验失败不得产生副作用');
    assert.equal(f.service.activeAttempt('s')?.attemptId, f.attemptId);
    const after = await f.service.readValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    assert.equal(after.attempt.execution, 'active');
    await f.service.saveTask('s', { title: 'second', requirement: 'r', checkpoints: [{ id: 'c', description: 'x' }] });
    const tasks = (await f.service.readValidation('s', {})).tasks;
    const secondTask = tasks.find(task => task.title === 'second');
    await assert.rejects(() => f.service.beginValidation('s', { taskId: secondTask.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true }), /已有进行中|进行中的验证轮次/);
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F07：延迟采集不能在取消后启动；运行中采集不能关联', async () => {
  const f = await fixture('f07');
  try {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    f.manager.applications = async () => { entered(); await gate; return [{ bundleName: 'com.demo.app' }]; };
    const starting = f.service.startCapture('s', { taskId: f.taskId, attemptId: f.attemptId, logAppBundle: 'com.demo.app' });
    await ready;
    await f.service.cancelValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    release();
    await assert.rejects(starting, /已结束|正在收尾|取消/);
    const read = await f.service.readValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    assert.equal(read.events.events.some(event => event.type === 'capture-started'), false);
    assert.equal(read.captures.length, 0);

    const second = await fixture('f07b');
    try {
      const standalone = await second.service.startCapture('s', { serial: 'SN1', logAppBundle: 'com.demo.app' });
      await assert.rejects(() => second.service.attachCapture('s', { captureId: standalone.captureId, taskId: second.taskId, attemptId: second.attemptId }), /仍在运行|不能关联/);
      await second.service.stopCapture('s', { captureId: standalone.captureId });
      const attached = await second.service.attachCapture('s', { captureId: standalone.captureId, taskId: second.taskId, attemptId: second.attemptId });
      assert.equal(attached.attemptId, second.attemptId);
    } finally { await second.host.dispose(); await rm(second.root, { recursive: true, force: true }); }
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F08：begin 提交失败回滚占位并把已落盘轮次标为中断', async () => {
  const f = await fixture('f08');
  try {
    await f.service.cancelValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    const original = f.service.store.appendEvent;
    f.service.store.appendEvent = async () => { throw new Error('fixture disk failure'); };
    let failure;
    try { await f.service.beginValidation('s', { taskId: f.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true }); }
    catch (error) { failure = error; }
    f.service.store.appendEvent = original;
    assert.match(failure.message, /fixture disk failure/);
    assert.equal(f.service.activeAttempt('s'), null, '失败的 begin 不能留下幽灵 active');
    const attempts = await f.service.store.listAttempts('s', f.taskId);
    const ghost = attempts.at(-1);
    assert.equal(ghost.execution, 'interrupted');
    const retry = await f.service.beginValidation('s', { taskId: f.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true });
    assert.equal(retry.attemptId.startsWith('attempt-'), true);
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F09：取消持久化采集状态；standalone 重启恢复不覆盖已终止事实', async () => {
  const f = await fixture('f09');
  try {
    const capture = await f.service.startCapture('s', { taskId: f.taskId, attemptId: f.attemptId, logAppBundle: 'com.demo.app' });
    await f.service.cancelValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    const before = await f.service.captureRecords('s', f.taskId, f.attemptId);
    assert.equal(before.length, 1);
    assert.equal(before[0].status, 'cancelled');
    assert.equal(before[0].integrity, 'interrupted');
    const recoveredHost = createService({}, f.root);
    await recoveredHost.status({ sessionId: 's' });
    const after = await recoveredHost.validation.captureRecords('s', f.taskId, f.attemptId);
    assert.equal(after[0].status, 'cancelled', '恢复不能把已提交的取消改成 interrupted');
    await recoveredHost.dispose();

    const disposal = await fixture('f09b');
    try {
      const live = await disposal.service.startCapture('s', { taskId: disposal.taskId, attemptId: disposal.attemptId, logAppBundle: 'com.demo.app' });
      await disposal.service.disposeSession('s');
      const persisted = await disposal.service.captureRecords('s', disposal.taskId, disposal.attemptId);
      assert.equal(persisted.find(record => record.captureId === live.captureId).status, 'cancelled', '会话关闭也要持久化采集收尾');
    } finally { await disposal.host.dispose(); await rm(disposal.root, { recursive: true, force: true }); }

    const standalone = await f.service.startCapture('s', { serial: 'SN1', logAppBundle: 'com.demo.app' });
    assert.equal(standalone.captureId.startsWith('cap-'), true);
    const recoveredAgain = createService({}, f.root);
    await recoveredAgain.status({ sessionId: 's' });
    const standaloneRecords = await recoveredAgain.validation.captureRecords('s');
    assert.equal(standaloneRecords.some(record => record.captureId === standalone.captureId), true, 'standalone 重启后仍可找回');
    await recoveredAgain.dispose();
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F10：证据保存缺口写入原轮次并出现在工具输出', async () => {
  const f = await fixture('f10');
  try {
    const bridge = createValidationBridge(() => f.service);
    const call = await bridge.begin('s', { callId: 'gap-call', operation: 'observe_screen', humanMode: false });
    const ended = await bridge.end('s', call.context, {
      callId: 'gap-call', operation: 'observe_screen', humanMode: false, result: { details: {} },
      observation: { data: Buffer.from('not-a-png'), geometry: { nativeWidth: 100, nativeHeight: 200 }, quality: { treeStatus: 'valid', scopeComplete: true }, nodes: [] },
    });
    assert.equal(ended.recorded, true);
    assert.equal(ended.gaps.length, 1);
    const read = await f.service.readValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    const toolEnd = read.events.events.find(event => event.type === 'tool-end' && event.callId === 'gap-call');
    assert.equal(toolEnd.data.gaps.length, 1);
    assert.match(toolEnd.data.gaps[0], /证据未保存/);
    assert.equal(read.attempt.evidenceGaps.some(item => /证据未保存/.test(item)), true);
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F11：采集日志分页统计全量/命中、限制响应预算且导出逐行合法', async () => {
  const f = await fixture('f11');
  try {
    const capture = await f.service.startCapture('s', { taskId: f.taskId, attemptId: f.attemptId, logAppBundle: 'com.demo.app' });
    await f.service.stopCapture('s', { captureId: capture.captureId });
    const records = await f.service.captureRecords('s', f.taskId, f.attemptId);
    const lines = Array.from({ length: 101 }, (_, index) => JSON.stringify({ pid: 1, message: (index === 100 ? 'excluded' : 'wanted') + 'x'.repeat(8100), level: 'info' }));
    await writeFile(join(records[0].directory, 'app-logs.jsonl'), lines.join('\n') + '\n');
    const page = await f.host.getLogs(f.id, { query: 'wanted', limit: 100 }, { sessionId: 's' });
    assert.equal(page.total, 101);
    assert.equal(page.filteredTotal, 100);
    assert.equal(page.entries.length < 100, true, '响应必须受 24KB 预算限制');
    assert.equal(Buffer.byteLength(JSON.stringify(page)) < 40000, true);
    assert.equal(page.nextOffset, page.entries.length);
    let exported = '';
    for await (const chunk of f.host.captureExport('s', { taskId: f.taskId, attemptId: f.attemptId, query: 'wanted' })) exported += chunk;
    const exportedLines = exported.split('\n').filter(Boolean);
    assert.equal(exportedLines.length, 100);
    for (const line of exportedLines) JSON.parse(line);
    await writeFile(join(records[0].directory, 'app-logs.jsonl'), lines.join('\n') + '\n' + '{broken-line');
    const withDamage = await f.host.getLogs(f.id, { query: 'wanted', limit: 10 }, { sessionId: 's' });
    assert.equal(withDamage.gaps.damaged, 1, '损坏行必须作为 gap 报告');
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F12：全部会话历史与同任务验证历史接通', async () => {
  const f = await fixture('f12');
  try {
    const foreign = await f.service.saveTask('other', { title: 'foreign fixture', requirement: 'r', checkpoints: [{ id: 'c', description: 'x' }] });
    const all = await f.host.listPage({ sessionId: 's', all: true, offset: 0, limit: 50 });
    assert.equal(all.runs.some(row => row.taskId === foreign.taskId), true, '全部历史必须包含其他会话任务');
    assert.equal(all.runs.find(row => row.taskId === foreign.taskId).sessionId, 'other');
    const scoped = await f.host.listPage({ sessionId: 's', offset: 0, limit: 50 });
    assert.equal(scoped.runs.some(row => row.taskId === foreign.taskId), false);
    await assert.rejects(() => f.host.report(foreign.taskId, { sessionId: 's' }), /找不到该任务/);

    await f.service.cancelValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    const second = await f.service.beginValidation('s', { taskId: f.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true });
    const report = await f.host.report(`${f.taskId}/${second.attemptId}`, { sessionId: 's' });
    assert.equal(report.related.length, 1, '同任务历史应列出其他轮次');
    assert.equal(report.related[0].attemptId, f.attemptId);
  } finally { await f.host.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('F01：client.jsx 通过 parser-only 检查', async () => {
  const { readFile } = await import('node:fs/promises');
  const { createRequire } = await import('node:module');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', '..', 'scripts', 'parse-client-jsx.cjs'), join(import.meta.dirname, '..', 'src', 'client.jsx')], { encoding: 'utf8' });
  if (result.status === 2) { assert.equal(JSON.stringify(result.stderr).includes('NO_PARSER'), true, '缺少解析器时明确跳过'); return; }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"parsed": true/);
  void readFile; void createRequire;
});
