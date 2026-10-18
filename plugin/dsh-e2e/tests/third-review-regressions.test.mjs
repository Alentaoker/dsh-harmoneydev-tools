// Third-round review regressions (G01–G07). Source-only: Node native TS loading,
// in-memory module hooks for the host/device boundary, no build/transform/install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createService } from '../src/service.mjs';
import { createValidationBridge } from '../../dsh-harmony/src/validation-bridge.ts';

const repo = new URL('../../../', import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'dsh-third-fixed-'));
const sharp = createRequire(import.meta.url)('sharp');
const png = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#333333' } }).png().toBuffer();

function fakeManager() {
  const state = { calls: [], callbacks: [] };
  return {
    state,
    async applications() { return [{ bundleName: 'com.demo.app' }]; },
    async listProcesses() { return [{ pid: 1, name: 'com.demo.app' }]; },
    async listDevices() { return []; },
    async readLogs() { return []; },
    streamLogs(serial, callback, signal) { state.callbacks.push(callback); callback([{ pid: 1, tag: 'com.demo.app', level: 'info', message: 'fixture' }]); return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    async snapshot(options) {
      state.calls.push(['snapshot', options.includeScreenshot]);
      return {
        serial: options.serial, generation: 7, revision: 3, capturedAt: new Date().toISOString(),
        quality: { treeStatus: 'valid', scopeComplete: true },
        nodes: [{ id: 'fixture', ref: 'g7-r3-n0', type: 'Text', text: 'fixture-node' }],
        ...(options.includeScreenshot ? { screenshot: { data: png, width: 100, height: 200 } } : {}),
      };
    },
    getLatestSnapshot() { return undefined; },
    async getDisplayGeometry() { return { nativeWidth: 100, nativeHeight: 200, orientation: 'portrait' }; },
  };
}

async function fixture(name = 'fixture') {
  const manager = fakeManager();
  const host = createService({ dshHarmony: { automation: { getManager: () => manager } } }, join(root, name));
  await host.status({ sessionId: 's' });
  const task = await host.validation.saveTask('s', { title: 'fixture', requirement: 'r', checkpoints: [{ id: 'c', description: 'check' }] });
  const started = await host.validation.beginValidation('s', { taskId: task.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true });
  return { host, v: host.validation, manager, taskId: task.taskId, attemptId: started.attemptId, id: `${task.taskId}/${started.attemptId}` };
}

test('G01/G02/G05/G06：真实 wrapper 的附件、控制回执、观察身份与树证据', async () => {
  const f = await fixture('wrapper');
  const saveImageCalls = [];
  const lease = { held: true };
  const entry = new URL('plugin/dsh-harmony/src/index.ts', repo).href;
  const hostRoot = join(root, 'harmony-host');
  const stubs = {
    './state': `export const dataRoot=${JSON.stringify(hostRoot)}; export function setHost(){}`,
    '../vendor/extensions/piora-harmony': `export default function (host) { host.registerTool({ name: 'harmony_control', description: 'fixture', async execute() { globalThis.__thirdFixed.lease.held = true; return { content: [{ type: 'text', text: 'fixture' }], details: {} }; } }); }`,
    '../vendor/lib/harmony': `export function getHarmonyDeviceManager() { return globalThis.__thirdFixed.manager; }`,
    '../vendor/lib/prompt-run-registry': `export function getActivePromptRun(){ return { runId: 'fixture-run', sessionId: 's' }; } export function beginPromptRun(){}; export async function finishPromptRun(){};`,
    './routes': `export const routes = [];`,
  };
  globalThis.__thirdFixed = { manager: f.manager, lease };
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === entry) {
        if (stubs[specifier]) return { url: 'third-fixed-stub:' + encodeURIComponent(specifier), shortCircuit: true };
        if (['./task-routing', './validation-bridge'].includes(specifier)) return { url: new URL(specifier + '.ts', entry).href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(id, context, next) {
      if (id.startsWith('third-fixed-stub:')) return { format: 'module', source: stubs[decodeURIComponent(id.slice('third-fixed-stub:'.length))], shortCircuit: true };
      return next(id, context);
    },
  });
  try {
    const { apply } = await import(entry);
    let bridge;
    const ctx = {
      dshE2E: { validation: f.v },
      attachments: { async saveImage(options) { saveImageCalls.push(options); return { id: 'attachment-fixture', mediaType: 'image/png' }; } },
      reflect: { provide(name, value) { bridge = value; return () => {}; } },
      effect: fn => fn(), on() {}, sessions: { list: () => [] },
    };
    apply(ctx);
    bridge.automation.taskRouting.register({ activeAttempt: sessionId => f.v.activeAttempt(sessionId) });

    const observed = await bridge.tool.execute({ operation: 'observe_screen', input: { serial: 'SN1' } }, { agent: { id: 's' }, callId: 'observe-wrapped', signal: new AbortController().signal });
    const image = observed.content.find(block => block.type === 'image');
    assert.equal(saveImageCalls.length, 1, '受保护图片必须经过宿主附件转换');
    assert.deepEqual(image.attachment, { id: 'attachment-fixture', mediaType: 'image/png' });
    assert.equal(Buffer.isBuffer(saveImageCalls[0].data), true);
    const events = (await f.v.readValidation('s', { taskId: f.taskId, attemptId: f.attemptId })).events.events;
    const saved = events.find(event => event.type === 'evidence-saved');
    const file = await f.v.evidenceFile('s', f.taskId, f.attemptId, saved.evidence[0]);
    assert.deepEqual(saveImageCalls[0].data, await readFile(file), '宿主附件与落盘证据同源');
    assert.equal(saved.data.generation, 7);
    assert.equal(saved.data.revision, 3);
    assert.equal(saved.data.geometryId, 'g-7-3');
    assert.equal(observed.details.protectedEvidence.attachment.id, 'attachment-fixture');
    assert.equal(events.some(event => event.type === 'evidence-attached' && event.data.attachmentId === 'attachment-fixture'), true);

    const tree = await bridge.tool.execute({ operation: 'observe_page', input: { serial: 'SN1' } }, { agent: { id: 's' }, callId: 'tree-only', signal: new AbortController().signal });
    assert.equal(JSON.parse(tree.content[0].text).nodes.length, 1);
    const checkpoint = await f.v.recordCheckpoint('s', { taskId: f.taskId, attemptId: f.attemptId, checkpointId: 'c', result: 'pass', evidence: [{ callId: 'tree-only' }] });
    assert.equal(checkpoint.checkpoints[0].result, 'pass');
    const treeEvents = events.concat((await f.v.readValidation('s', { taskId: f.taskId, attemptId: f.attemptId })).events.events);
    const treeSaved = treeEvents.find(event => event.type === 'observation-saved' && event.callId === 'tree-only');
    assert.equal(!!treeSaved, true, '树观察必须落盘为可回读证据');
    const treeFile = await f.v.evidenceFile('s', f.taskId, f.attemptId, treeSaved.evidence[0]);
    const treeDocument = JSON.parse(await readFile(treeFile, 'utf8'));
    assert.equal(JSON.stringify(treeDocument.nodes).includes('g7-r3-n0'), true);


    await bridge.tool.execute({ operation: 'tap', input: { serial: 'SN1', x: 1, y: 1 } }, { agent: { id: 's' }, callId: 'control-with-lease', signal: new AbortController().signal });
    const before = await f.host.report(f.id, { sessionId: 's' });
    assert.equal(before.run.checks.leaseReleased, false, '没有 Harmony 释放回执时不能显示已释放');
    assert.equal(lease.held, true);
    await f.v.finishValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    const after = await f.host.report(f.id, { sessionId: 's' });
    assert.equal(after.run.checks.leaseReleased, false);
    await f.v.confirmControlRelease('s', { taskId: f.taskId, attemptId: f.attemptId, released: true, source: 'fixture-turn-idle' });
    const confirmed = await f.host.report(f.id, { sessionId: 's' });
    assert.equal(confirmed.run.checks.leaseReleased, true);
    // A fresh service instance can read the archived tree without the manager.
    const reopened = createService({}, join(root, 'wrapper'));
    await reopened.status({ sessionId: 's' });
    assert.deepEqual(await reopened.validation.readEvidence('s', { taskId: f.taskId, attemptId: f.attemptId, name: treeSaved.evidence[0] }), await readFile(treeFile));
    await reopened.dispose();
  } finally { hook.deregister(); await f.host.dispose(); }
});

test('G02：重复回执不结算其他调用；pending 期间拒绝新轮，收敛后才释放', async () => {
  const f = await fixture('counter');
  try {
    const bridge = createValidationBridge(() => f.v);
    const a = await bridge.begin('s', { callId: 'a', operation: 'tap', humanMode: false });
    await bridge.begin('s', { callId: 'b', operation: 'tap', humanMode: false });
    const firstEnd = await bridge.end('s', a.context, { callId: 'a', operation: 'tap', humanMode: false, result: { details: {} } });
    const duplicateEnd = await bridge.end('s', a.context, { callId: 'a', operation: 'tap', humanMode: false, result: { details: {} } });
    assert.equal(firstEnd.recorded, true);
    assert.equal(duplicateEnd.duplicate, true);
    assert.equal(!!(await f.v.openCall('s', 'b')), true, '重复回执不能清空另一个调用');
    const cancelled = await f.v.cancelValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    assert.equal(cancelled.cleanup, 'pending');
    await assert.rejects(() => f.v.beginValidation('s', { taskId: f.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true }), /设备|进行中/);
    const late = await bridge.end('s', null, { callId: 'b', operation: 'tap', humanMode: false, result: { details: {} } });
    assert.equal(late.recorded, true);
    const resolved = await f.v.resolveCleanup('s', { taskId: f.taskId, attemptId: f.attemptId });
    assert.equal(resolved.cleanup, 'released');
    const next = await f.v.beginValidation('s', { taskId: f.taskId, serial: 'SN1', mode: 'ai', verifyExisting: true });
    assert.equal(next.attemptId.startsWith('attempt-'), true);
  } finally { await f.host.dispose(); }
});

test('G03：预算冻结连续页，跨页不漏不重；UTF-8 实际字节上报', async () => {
  const f = await fixture('pagination');
  try {
    const capture = await f.v.startCapture('s', { taskId: f.taskId, attemptId: f.attemptId, logAppBundle: 'com.demo.app' });
    await f.v.stopCapture('s', { captureId: capture.captureId });
    const record = (await f.v.captureRecords('s', f.taskId, f.attemptId))[0];
    const lines = Array.from({ length: 20 }, (_, index) => JSON.stringify({ pid: 1, level: 'info', message: `${index}:` + 'x'.repeat(1990) }));
    lines.push(JSON.stringify({ pid: 1, level: 'info', message: '20:short' }));
    await writeFile(join(record.directory, 'app-logs.jsonl'), lines.join('\n') + '\n');
    let offset = 0; const sequence = [];
    for (let page = 0; page < 8; page++) {
      const result = await f.v.captureLogPage('s', { taskId: f.taskId, attemptId: f.attemptId, offset, limit: 100 });
      sequence.push(...result.entries.map(entry => Number.parseInt(entry.message)));
      assert.equal(result.gaps.responseBytes, Buffer.byteLength(JSON.stringify(result)), '上报字节必须等于实际 UTF-8 响应字节');
      if (result.nextOffset === null) break;
      offset = result.nextOffset;
    }
    assert.deepEqual(sequence, Array.from({ length: 21 }, (_, index) => index), '跨页顺序完整且无重复');

    const chinese = Array.from({ length: 30 }, (_, index) => JSON.stringify({ seq: index, pid: 1, level: 'info', message: '中'.repeat(1990) }));
    await writeFile(join(record.directory, 'app-logs.jsonl'), chinese.join('\n') + '\n');
    const page = await f.v.captureLogPage('s', { taskId: f.taskId, attemptId: f.attemptId, limit: 100 });
    assert.equal(page.gaps.responseBytes, Buffer.byteLength(JSON.stringify(page)));
    assert.equal(Buffer.byteLength(JSON.stringify(page)) < 40000, true, '中文长行不能突破响应预算');
    assert.equal(page.entries.length < 30, true);
  } finally { await f.host.dispose(); }
});

test('G04：全部会话贯穿任务/轮次/详情/日志/证据，当前会话仍隔离', async () => {
  const f = await fixture('history');
  try {
    const foreign = await f.v.saveTask('other', { title: 'other', requirement: 'r', checkpoints: [{ id: 'c', description: 'c' }] });
    const attempt = await f.v.beginValidation('other', { taskId: foreign.taskId, serial: 'SN2', mode: 'ai', verifyExisting: true });
    await f.v.store.writeEvidence('other', foreign.taskId, attempt.attemptId, 'foreign.png', Buffer.from('png'));
    await f.v.finishValidation('other', { taskId: foreign.taskId, attemptId: attempt.attemptId });
    const all = await f.host.listPage({ sessionId: 's', all: true, offset: 0, limit: 50 });
    const foreignRow = all.runs.find(row => row.sessionId === 'other');
    assert.equal(foreignRow.kind, 'attempt', '外会话已有轮次时必须显示轮次而非 draft 任务');
    assert.equal(foreignRow.attemptId, attempt.attemptId);
    const taskReport = await f.host.report(foreign.taskId, { sessionId: 's', all: true });
    assert.equal(taskReport.run.taskId, foreign.taskId);
    const attemptReport = await f.host.report(`${foreign.taskId}/${attempt.attemptId}`, { sessionId: 's', all: true });
    assert.equal(attemptReport.run.sessionId, 'other');
    const logs = await f.host.getLogs(`${foreign.taskId}/${attempt.attemptId}`, { offset: 0, limit: 10 }, { sessionId: 's', all: true });
    assert.equal(Array.isArray(logs.entries), true);
    const evidencePath = await f.host.evidenceFileFor({ sessionId: 's', all: true }, foreign.taskId, attempt.attemptId, 'foreign.png');
    assert.deepEqual(await readFile(evidencePath), Buffer.from('png'));
    await assert.rejects(() => f.host.report(foreign.taskId, { sessionId: 's' }), /找不到该任务/);
    await assert.rejects(() => f.host.evidenceFileFor({ sessionId: 's' }, foreign.taskId, attempt.attemptId, 'foreign.png'), /找不到该任务/);
    const again = await f.v.beginValidation('other', { taskId: foreign.taskId, serial: 'SN2', mode: 'ai', verifyExisting: true });
    assert.equal(again.attemptId.startsWith('attempt-'), true, '外会话在全部只读模式下仍可按自身会话继续验证');
    await f.v.cancelValidation('other', { taskId: foreign.taskId, attemptId: again.attemptId });
  } finally { await f.host.dispose(); }
});

test('G07：取消时 attempt 日志完整性与采集真实完整性一致', async () => {
  const f = await fixture('integrity');
  try {
    const capture = await f.v.startCapture('s', { taskId: f.taskId, attemptId: f.attemptId, logAppBundle: 'com.demo.app' });
    const cancelled = await f.v.cancelValidation('s', { taskId: f.taskId, attemptId: f.attemptId });
    const record = (await f.v.captureRecords('s', f.taskId, f.attemptId)).find(item => item.captureId === capture.captureId);
    assert.equal(record.status, 'cancelled');
    assert.equal(record.integrity, 'interrupted');
    assert.equal(cancelled.logIntegrity, 'interrupted', '轮次不能把中断的采集汇总成 complete');
  } finally { await f.host.dispose(); }
});

test.after(async () => { await rm(root, { recursive: true, force: true }); });
