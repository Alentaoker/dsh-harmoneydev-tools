import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { compilePattern, compileLogQuery } from '../src/log-query.mjs';
import { createLogArchive, archivedLogPage, boundedLogLines, exportLogStream } from '../src/log-archive.mjs';
import { createLogLibrary, parseImportedLog } from '../src/log-library.mjs';
import { validateRun } from '../src/service.mjs';
import { registerRoutes } from '../src/index.mjs';

test('结构化字段、大小写、正则过滤；危险和无效正则立即拒绝', () => {
  const value = { timestamp: '10-14 01:02:03.004', pid: 61, tid: 63, tag: 'C04707/test.app/HaAppEvent', level: 'error', message: 'ERROR timeout', capturedAt: '2026-10-14T01:02:03Z' };
  assert.equal(compileLogQuery({ tag: '^HaAppEvent$', domain: 'C04707', pid: '^61$', tid: '63', level: 'warn', query: 'error|timeout', regex: true })(value), true);
  assert.equal(compileLogQuery({ query: 'error', caseSensitive: true })(value), false);
  assert.equal(compileLogQuery({ from: '2026-10-14T01:03:00Z' })(value), false);
  for (const pattern of ['(a+)+$', 'a+X', 'a.*b.*c', '[', '\\1', 'a{9999}', 'a{1,}']) assert.throws(() => compilePattern(pattern, { regex: true }));
  assert.equal(compilePattern('^.*timeout', { regex: true }).test('error timeout'), true);
  assert.equal(compilePattern('[0-9]+', { regex: true }).test('61'), true);
  assert.deepEqual(compilePattern('error').ranges('ERROR error'), [[0, 5], [6, 11]]);
});

test('流式存储保留超过内存尾部的早期日志，连续分页不会跳行，损坏尾行可恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-e2e-log-archive-'));
  try {
    const warnings = [], job = { id: 'archive', directory, args: {}, logCollection: { status: 'capturing', warnings } };
    job.logArchive = await createLogArchive(job, value => warnings.push(value));
    for (let batch = 0; batch < 8; batch++) {
      for (let i = 0; i < 200; i++) job.logArchive.enqueue({ pid: 61, tid: 62, tag: 'test', message: `${batch * 200 + i} ` + 'x'.repeat(1000), level: 'info' });
      await job.logArchive.flush();
    }
    await job.logArchive.close(); assert.equal(job.logCollection.persisted, 1600);
    let offset = 0, read = 0;
    do { const page = await archivedLogPage(job, { offset, limit: 100 }); assert.equal(page.total, 1600); assert.ok(page.entries.length < 100); for (const entry of page.entries) assert.equal(parseInt(entry.message), read++); offset = page.nextOffset; } while (offset !== null);
    assert.equal(read, 1600);
    await appendFile(join(directory, 'app-logs.jsonl'), '{unfinished');
    const recovered = await archivedLogPage({ id: 'archive', directory }, { limit: 2 });
    assert.equal(recovered.total, 1600); assert.match(recovered.logCollection.warnings.join(), /损坏/);
    assert.equal(recovered.logCollection.status, 'partial');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('写盘容量和队列有限，超限明确报告；超长行解析内存有限', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-e2e-log-limit-'));
  try {
    const warnings = [], job = { directory, args: { logMaxBytes: 300 }, logCollection: { warnings } };
    const archive = await createLogArchive(job, value => warnings.push(value));
    for (let i = 0; i < 20; i++) archive.enqueue({ message: 'x'.repeat(50) });
    await archive.close(); assert.ok(job.logCollection.bytesWritten <= 300); assert.ok(job.logCollection.diskDropped > 0); assert.match(warnings.join(), /上限/);
    const rows = []; for await (const value of boundedLogLines(Readable.from([Buffer.from('x'.repeat(100000)), Buffer.from('\n正常\n')]), 8192)) rows.push(value);
    assert.equal(rows[0].line.length, 8192); assert.equal(rows[0].truncated, true); assert.equal(rows[1].line, '正常');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('离线日志按会话隔离、无需模型，分块导入保留原始UTF-8、自动识别HiLog和未知行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-log-library-'));
  try {
    const scope = {sessionId:'session-A'}, library = createLogLibrary(root), source = Buffer.from('10-14 01:02:03.004 61 63 E C04707 HaAppEvent: 发生错误\n10-14 01:02:04.005 61-64 C02300/test.app/Worker I 完成任务\n原文无法解析\n');
    const upload = await library.begin({ name: 'hi.log', size: source.length }, scope);
    await assert.rejects(library.chunk(upload.id, 1, source.slice(0, 3), scope), /顺序/);
    for (let at = 0, index = 0; at < source.length; at += 7) await library.chunk(upload.id, index++, source.slice(at, at + 7), scope);
    const completed = await library.finish(upload.id, scope); assert.equal(completed.parsed, 2); assert.equal(completed.unparsed, 1);
    assert.equal((await library.list(0,20,scope)).files[0].id, completed.id);
    const page = await library.getLogs(completed.id, { tag: 'HaAppEvent', domain: 'C04707', pid: '61', tid: '63', level: 'error', limit: 2 }, scope);
    assert.equal(page.total, 3); assert.equal(page.filteredTotal, 1); assert.equal(page.entries[0].message, '发生错误');
    const raw = await library.source(completed.id, scope); assert.deepEqual(await readFile(raw.path), source);
    let exported = ''; for await (const chunk of await library.export(completed.id, { level: 'error' }, scope)) exported += chunk.toString(); assert.equal(exported.trim().split('\n').length, 1); assert.equal(JSON.parse(exported).message, '发生错误');
    await assert.rejects(library.begin({ name: 'big.log', size: 32 * 1024 * 1024 + 1 }, scope), /32 MiB/);
    assert.equal(parseImportedLog('{"tag":"App","message":"api_key=private-value"}').message, 'api_key=[redacted]');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实HDC格式拆分DOMAIN/进程/TAG；BOM及多字节分块有效，UTF-16明确拒绝', async () => {
  const entry = parseImportedLog('\uFEFF10-14 00:31:06.731 38197 38222 W C02B75/media_analysis_service/MediaCV: [message]');
  assert.equal(entry.domain, 'C02B75'); assert.equal(entry.process, 'media_analysis_service'); assert.equal(entry.tag, 'MediaCV'); assert.equal(entry.pid, 38197); assert.equal(entry.level, 'warn');
  assert.equal(parseImportedLog('\uFEFF{"message":"BOM JSON"}').parsed, true);
  await assert.rejects(async () => { for await (const _ of boundedLogLines(Readable.from([Buffer.from([0xff, 0xfe, 0x00])]), 8192, true)) {} }, /UTF-8/);
  await assert.rejects(async () => { for await (const _ of boundedLogLines(Readable.from([Buffer.from('a\0b')]), 8192, true)) {} }, /UTF-16/);
});

test('离线日志路由需要会话；测试默认预算为最大值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-log-routes-'));
  try {
    const routes = new Map(), library = createLogLibrary(root), ctx = { effect(fn) { fn(); }, connection: { fetch: { register(route) { routes.set(route.path, route); } } } };
    registerRoutes(ctx, { logLibrary: library });
    const response = await routes.get('/api/dsh-e2e/log-library/list').fetch(new Request('http://localhost/api/dsh-e2e/log-library/list'));
    assert.equal(response.status, 400); const scoped = await routes.get('/api/dsh-e2e/log-library/list').fetch(new Request('http://localhost/api/dsh-e2e/log-library/list?sessionId=A')); assert.equal(scoped.status, 200); assert.equal((await scoped.json()).total, 0);
    const run = validateRun({ goal: '检查页面', expectation: '标题可见' });
    assert.deepEqual([run.timeoutMs, run.maxActions, run.maxModelCalls], [300000, 30, 20]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
