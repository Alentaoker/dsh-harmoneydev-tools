import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLegacyReader } from '../src/legacy.mjs';
import { createService } from '../src/service.mjs';

const flow = 'a'.repeat(24);

async function legacyFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-legacy-'));
  const id = randomUUID(), other = randomUUID();
  const directory = join(root, 'workflows', flow, 'runs', id);
  const broken = join(root, 'workflows', flow, 'runs', other);
  await mkdir(join(directory, 'e2e'), { recursive: true });
  await mkdir(broken, { recursive: true });
  await writeFile(join(directory, 'record.json'), JSON.stringify({ id, flowId: flow, sessionId: 's1', name: '旧任务', status: 'running', createdAt: '2026-10-01T00:00:00.000Z', checks: {} }));
  await writeFile(join(directory, 'dsh-run.json'), JSON.stringify({ id, flowId: flow, sessionId: 's1', args: { goal: '打开设置' }, logs: [{ message: 'x' }] }));
  await writeFile(join(directory, 'app-logs.meta.json'), JSON.stringify({ status: 'captured', persisted: 3 }));
  await writeFile(join(directory, 'e2e', 'report.json'), JSON.stringify({ run: { summary: { passed: 1 } } }));
  await writeFile(join(directory, 'e2e', 'summary.md'), '# 旧报告');
  await writeFile(join(broken, 'record.json'), '{broken json');
  try { await run({ root, id, directory, broken }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function fingerprint(directory) {
  const hash = createHash('sha256');
  for (const file of (await readdir(directory, { recursive: true })).sort()) {
    const path = join(directory, file);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    hash.update(file).update(await readFile(path)).update(String(info.mtimeMs));
  }
  return hash.digest('hex');
}

test('旧记录只读：读取前后文件内容与 mtime 完全不变，running 只在展示层解释为中断', () => legacyFixture(async ({ root, id, directory }) => {
  const before = await fingerprint(directory);
  const reader = createLegacyReader(root);
  const rows = await reader.list({ sessionId: 's1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'interrupted');
  assert.equal(rows[0].legacy.originalStatus, 'running');
  assert.equal(rows[0].legacy.readOnly, true);
  assert.equal(rows[0].legacy.dispatchState, 'unknown');
  assert.equal(rows[0].legacy.logIntegrity, 'legacy-derived');
  const record = await reader.get(id, { sessionId: 's1' });
  assert.equal(record.format, 'legacy-e2e-v1');
  assert.equal(record.args.goal, '打开设置');
  const report = await reader.report(id, { sessionId: 's1' });
  assert.equal(report.report.run.summary.passed, 1);
  const after = await fingerprint(directory);
  assert.equal(after, before, '旧文件（含 mtime）不得被读取改写');
  // The on-disk status is still the original one.
  assert.equal(JSON.parse(await readFile(join(directory, 'record.json'), 'utf8')).status, 'running');
}));

test('旧记录会话隔离：其他会话读不到，跨越 all 只在该层放行', () => legacyFixture(async ({ root, id }) => {
  const reader = createLegacyReader(root);
  assert.deepEqual(await reader.list({ sessionId: 's2' }), []);
  await assert.rejects(() => reader.get(id, { sessionId: 's2' }), /不属于当前会话/);
  assert.equal((await reader.list({ all: true })).length, 1);
}));

test('破损旧记录不遮挡其他历史，也不抛到大列表', () => legacyFixture(async ({ root }) => {
  const reader = createLegacyReader(root);
  assert.equal((await reader.list({ sessionId: 's1' })).length, 1);
}));

test('合并列表：新 validation-v1 与旧只读行同时出现且格式可区分', () => legacyFixture(async ({ root }) => {
  const service = createService({}, root);
  const page = await service.listPage({ sessionId: 's1', offset: 0, limit: 20 });
  assert.equal(page.runs.length, 1);
  assert.equal(page.runs[0].format, 'legacy-e2e-v1');
  assert.deepEqual(page.formats, ['validation-v1', 'legacy-e2e-v1']);
  const status = await service.status({ sessionId: 's1' });
  assert.equal(status.harmonyReady, false, '只装 E2E 时日志与历史仍可用');
  assert.equal(status.retiredOperations.includes('run'), true);
  assert.equal(status.notCollected.includes('推理过程'), true);
  const report = await service.report(page.runs[0].id, { sessionId: 's1' });
  assert.equal(report.diagnostics.readOnly, true);
  assert.equal(Array.isArray(report.view.steps), true, '旧历史仍按既有报告视图提供，不重写文件');
  await service.dispose();
}));

test('源码入口不再 eager import 第三方执行框架', async () => {
  const directory = new URL('../src/', import.meta.url);
  const files = await readdir(directory);
  assert.equal(files.includes('engine.mjs'), false);
  assert.equal(files.includes('executor.mjs'), false);
  assert.equal(files.includes('rpc.mjs'), false);
  for (const file of files.filter(name => name.endsWith('.mjs'))) {
    const text = await readFile(new URL(file, directory), 'utf8');
    assert.equal(/from\s+['"]e2e(\/|['"])/.test(text), false, `${file} 仍 import 第三方 e2e`);
    assert.equal(/DSH_E2E_BRIDGE/.test(text), false, `${file} 仍有 runner RPC bridge`);
    assert.equal(/ctx\.llm\.stream|llm\.stream\(/.test(text), false, `${file} 仍有内层模型循环`);
  }
});
