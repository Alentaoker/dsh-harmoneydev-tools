import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { paginate } from '../src/records.mjs';
import { createService } from '../src/service.mjs';
import { requestScope, mutationBody, registerRoutes } from '../src/index.mjs';
import { reportView, failureCategory, statusLabels } from '../src/presentation.mjs';
import { maskedEvidence } from '../src/evidence.mjs';

const record = (sessionId, status = 'failed') => ({ id: randomUUID(), flowId: 'a'.repeat(24), sessionId, name: '测试记录', status, createdAt: new Date().toISOString(), args: { name: '测试记录', goal: '检查界面', expectation: '界面可见', collectLogs: false } });

test('分类分页：会话隔离、状态计数、offset 与 all 语义', () => {
  const rows = [];
  for (let i = 0; i < 42; i++) { const r = record(i < 35 ? 'first' : 'second', i % 2 ? 'passed' : 'failed'); r.createdAt = new Date(1000 + i * 1000).toISOString(); rows.push(r); }
  const p = paginate(rows, { sessionId: 'first', limit: 20 });
  assert.equal(p.total, 35); assert.equal(p.nextOffset, 20); assert.equal(p.runs.some(r => r.sessionId === 'second'), false);
  assert.equal(paginate(rows, { sessionId: 'first', offset: 20 }).runs.length, 15);
  assert.equal(paginate(rows, { sessionId: 'second', status: 'passed' }).runs.length, 4);
  assert.equal(paginate(rows, {}).total, 0);
  assert.equal(paginate(rows, { sessionId: 'second', all: true }).total, 42);
  assert.throws(() => paginate(rows, { limit: 500 }), /分页/);
});

test('结果分类：未完成、视觉不可用和模型失败分开显示', () => {
  assert.equal(statusLabels.incomplete, '未完成');
  assert.equal(failureCategory({ status: 'incomplete' }).label, '必验项未完成');
  assert.equal(failureCategory({ status: 'failed', errorCode: 'VISION_UNAVAILABLE' }).label, '视觉验收不可用');
  assert.equal(failureCategory({ status: 'failed', error: 'AccountQuotaExceeded 429' }).label, '模型服务不可用');
  assert.equal(failureCategory({ status: 'running' }), null);
});

test('旧报告视图只归一化真实嵌套结构，缺指标不当作零', () => {
  const job = { status: 'failed', error: 'AccountQuotaExceeded 429', args: { goal: '测试' } };
  const report = { run: { summary: { failed: 1 }, results: [{ attempts: [{ artifacts: [{ kind: 'log', path: 'attempt/failure.txt' }], steps: [{ id: 'a', label: '执行', status: 'failed', metrics: { modelCalls: 4, actionSteps: 2 }, events: [{ kind: 'engine', name: 'tap', status: 'failed' }], error: { message: '控件失效' } }] }] }] } };
  const view = reportView(job, report);
  assert.equal(view.steps.length, 1); assert.equal(view.totals.modelCalls, 4); assert.equal(view.files[0].file, 'e2e/attempt/failure.txt');
  assert.equal(view.screenshots.length, 0); assert.equal(view.failure.label, '模型服务不可用'); assert.equal(view.reportWritten, true);
  assert.equal(reportView(job, undefined).reportWritten, false);
  const actions = reportView({ status: 'passed' }, { run: { results: [{ attempts: [{ steps: [{ id: 'home', kind: 'resource', api: 'device.home', status: 'passed' }, { id: 'tap', kind: 'locator', api: 'locator.tap', events: [{ kind: 'engine', name: 'tap', status: 'passed', count: 1 }] }, { id: 'assert', kind: 'assertion', events: [{ kind: 'poll', name: 'expect', count: 3 }] }] }] }] } });
  assert.equal(actions.totals.actions, 2); assert.equal(actions.totals.modelCalls, 0);
});

test('截图证据：遮挡敏感区域、拒绝几何不一致与不完整控件树', async () => {
  const data = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const raw = { screenshot: { data }, quality: { treeStatus: 'valid', scopeComplete: true }, nodes: [{ hint: '密码', bounds: { left: 0, top: 0, right: 50, bottom: 50 } }] }, g = { nativeWidth: 100, nativeHeight: 100 };
  const image = await maskedEvidence(raw, g), pixel = await sharp(image).raw().toBuffer(); assert.equal(pixel[0], 17);
  await assert.rejects(maskedEvidence(raw, { ...g, nativeWidth: 101 }), /不一致/);
  await assert.rejects(maskedEvidence({ ...raw, quality: { treeStatus: 'valid', scopeComplete: false } }, g), /完整/);
});

test('网页读取需要会话；全部历史只读不能放宽写入；跨站与大请求被拒', async () => {
  assert.throws(() => requestScope(new Request('http://localhost/report?id=x')), /会话/);
  const req = new Request('http://localhost/report?sessionId=one&scope=all');
  assert.equal(requestScope(req).all, true); assert.equal(requestScope(req, true).all, false);
  await assert.rejects(mutationBody(new Request('http://localhost/cancel', { method: 'POST', headers: { origin: 'https://other.example' }, body: '{}' })), /来源/);
  await assert.rejects(mutationBody(new Request('http://localhost/cancel', { method: 'POST', body: 'a'.repeat(5000) })), /过大/);
});

test('旧证据文件路由：会话/路径/类型检查有效，原图像字节不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-routes-'));
  const service = createService({}, root);
  try {
    const r = record('one', 'passed'), directory = join(root, 'workflows', r.flowId, 'runs', r.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'record.json'), JSON.stringify(r));
    await writeFile(join(directory, 'dsh-run.json'), JSON.stringify(r));
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await writeFile(join(directory, 'before.png'), png);
    const routes = new Map();
    registerRoutes({ effect: fn => fn(), connection: { fetch: { register(route) { assert.equal(route.requestBody, 'buffered', 'DSH 的 bodyless GET 不能落入 streaming 分支'); routes.set(route.path, route); } } } }, service);
    const invoke = (path, query) => routes.get('/api/dsh-e2e/' + path).fetch(new Request('http://localhost/api/dsh-e2e/' + path + '?id=' + r.id + '&' + query));
    const image = await invoke('artifact', 'sessionId=one&file=before.png');
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal((await invoke('artifact', 'sessionId=two&file=before.png')).status, 404);
    assert.equal((await invoke('report', 'sessionId=two')).status, 400);
    assert.equal((await invoke('artifact', 'sessionId=two&scope=all&file=before.png')).status, 200);
    assert.equal((await invoke('artifact', 'file=before.png')).status, 404);
    assert.equal((await invoke('artifact', 'sessionId=one&file=..%2F..%2Foutside.png')).status, 404);
    assert.equal((await invoke('artifact', 'sessionId=one&file=image.svg')).status, 404);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});
