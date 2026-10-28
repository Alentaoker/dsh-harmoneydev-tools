import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLogLibrary } from '../src/log-library.mjs';
import { registerRoutes, mutationBody } from '../src/index.mjs';
import { appendLogDraft, logAnalysisPrompt, importLogFile } from '../src/log-client.mjs';
import { legacyTrashFixture } from './legacy-trash-fixture.mjs';
const A = { sessionId: 'session-A' }, B = { sessionId: 'session-B' };
const sample = '10-14 01:02:03.004 61 62 E C04707 Work: 发生错误\r\n\r\n原文\n10-14 01:02:04.000 61 62 I C04707 Work: 恢复\n';
async function fixture(fn) { const root = await mkdtemp(join(tmpdir(), 'dsh-session-logs-')); const library = createLogLibrary(root); try { await fn(library, root); } finally { await library.dispose(); await rm(root, { recursive: true, force: true }); } }
async function upload(library, scope, name = 'same.log', text = sample, extra = {}) { const bytes = Buffer.from(text), started = await library.begin({ name, size: bytes.length, ...extra }, scope); await library.chunk(started.id, 0, bytes, scope); return library.finish(started.id, scope); }

test('会话列表、正文、原文件、导出及所有写入拒绝跨会话；没有全局回退', () => fixture(async library => {
  await assert.rejects(library.list(), /会话/);
  const file = await upload(library, A), pending = await library.begin({ name: 'pending.log', size: 1 }, A);
  assert.equal((await library.list(0, 20, B)).total, 0);
  for (const action of [() => library.info(file.id, B), () => library.source(file.id, B), () => library.getLogs(file.id, {}, B), () => library.export(file.id, {}, B), () => library.remove({ ids: [file.id] }, B), () => library.rename(file.id, 'other.log', B), () => library.chunk(pending.id, 0, Buffer.from('x'), B), () => library.finish(pending.id, B), () => library.abort(pending.id, B)]) await assert.rejects(action());
  assert.equal((await library.list(0, 20, A)).total, 1); await library.abort(pending.id, A);
}));
test('原始字节与SHA256完整保留；空行后的稳定源行号可用于AI上下文', () => fixture(async library => {
  const file = await upload(library, A), raw = await library.source(file.id, A);
  assert.equal(file.sha256, createHash('sha256').update(sample).digest('hex')); assert.deepEqual(await readFile(raw.path), Buffer.from(sample));
  const logs = await library.getLogs(file.id, { lineFrom: 3, lineUntil: 4, fullMessage: true }, A);
  assert.deepEqual(logs.entries.map(row => row.sourceLine), [3, 4]); assert.equal(logs.entries[0].message, '原文');
  await assert.rejects(library.getLogs(file.id, { lineFrom: 8, lineUntil: 2 }, A), /行号/);
}));
test('跨页全选冻结ID集合，永久删除排除单文件及之后的新导入，不触及其他会话', () => fixture(async (library, root) => {
  const records = []; for (let i = 0; i < 23; i++) records.push(await upload(library, A, 'file-' + i + '.log'));
  const foreign = await upload(library, B), selection = await library.select({}, A); assert.equal(selection.count, 23);
  const later = await upload(library, A, 'later.log');
  await assert.rejects(library.remove({ token: selection.token }, B), /会话/);
  const removed = await library.remove({ token: selection.token, exclude: [records[0].id] }, A); assert.equal(removed.removed, 22);
  assert.equal((await library.list(0, 100, A)).total, 2); assert.ok((await library.info(later.id, A)).id);
  await assert.rejects(library.source(records[1].id, A)); assert.equal(removed.permanent, true); assert.equal(removed.batchId, undefined);
  const bucket = createHash('sha256').update(A.sessionId).digest('hex');
  await assert.rejects(readFile(join(root, 'log-library', 'sessions', bucket, records[1].id, 'source.log')), /ENOENT/);
  await assert.rejects(readdir(join(root, 'log-library', 'trash')), /ENOENT/);
  assert.equal((await library.trash(0, 20, A)).total, 0); assert.equal((await library.info(foreign.id, B)).id, foreign.id);
  await assert.rejects(library.remove({ token: selection.token }, A), /过期/);
}));
test('改名只更新展示元数据；旧版本已有回收记录默认保留且兼容单份恢复', () => fixture(async (library, root) => {
  const one = await upload(library, A, 'Z.log'), two = await upload(library, A, 'A.log', sample, { sourceKind: 'realtime', snapshot: { bundle: 'test.app', evicted: 7, dropped: 3 } });
  await library.rename(one.id, 'B.log', A); assert.equal((await library.list(0, 20, A, { sort: 'name' })).files[0].id, two.id);
  assert.equal((await library.list(0, 20, A, { sourceKind: 'realtime' })).total, 1); assert.deepEqual(await readFile((await library.source(one.id, A)).path), Buffer.from(sample));
  await assert.rejects(library.rename(one.id, '../oops', A), /名称/);
  const removed = await legacyTrashFixture(root, A, [one.id, two.id]); assert.equal((await library.trash(0, 20, A)).total, 2);
  const restarted = createLogLibrary(root); try { assert.equal((await restarted.list(0, 20, A)).total, 0); assert.equal((await restarted.trash(0, 20, A)).total, 2); } finally { await restarted.dispose(); }
  const usage = await library.usage(A); assert.equal(usage.files, 0); assert.equal(usage.trashFiles, 2); assert.ok(usage.trashBytes > Buffer.byteLength(sample) * 2);
  await library.restore(removed.batchId, A, [one.id]); assert.equal((await library.trash(0, 20, A)).total, 1); assert.equal((await library.list(0, 20, A)).total, 1);
  assert.match((await library.getLogs(two.id, {}, A).catch(e => ({ error: e.message }))).error, /没有/);
  const boundary = (await library.trash(0, 20, A)).snapshotBefore; await library.purge(A, boundary); assert.equal((await library.trash(0, 20, A)).total, 0); assert.equal((await library.info(one.id, A)).name, 'B.log');
}));
test('取消写入和解析清理半份文件，并释放并发导入名额', () => fixture(async (library, root) => {
  const started = await library.begin({ name: 'cancel.log', size: 262144 }, A), writing = library.chunk(started.id, 0, Buffer.alloc(262144, 97), A);
  await library.abort(started.id, A); await writing;
  const next = await library.begin({ name: 'next.log', size: 1 }, A); await library.abort(next.id, A);
  assert.equal((await library.list(0, 20, A)).total, 0);
  const key = createHash('sha256').update(A.sessionId).digest('hex'); assert.deepEqual(await readdir(join(root, 'log-library', 'sessions', key)), []);
}));
test('旧共享日志明确归属后复制校验并重建行号；旧数据保留且不重复归属', () => fixture(async (library, root) => {
  const id = randomUUID(), dir = join(root, 'log-library', id); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'source.log'), sample);
  await writeFile(join(dir, 'library.json'), JSON.stringify({ id, name: 'old.log', size: Buffer.byteLength(sample), count: 3, status: 'ready', createdAt: '2026-10-13T00:00:00.000Z' }));
  assert.equal((await library.list(0, 20, A)).total, 0); assert.equal((await library.unassigned(A)).total, 1);
  const assigned = await library.assign(id, A); assert.notEqual(assigned.id, id); assert.equal(assigned.sessionId, A.sessionId); assert.deepEqual(await readFile(join(dir, 'source.log')), Buffer.from(sample));
  assert.equal((await library.getLogs(assigned.id, {}, A)).entries[1].sourceLine, 3); assert.equal((await library.unassigned(B)).total, 0); await assert.rejects(library.assign(id, B), /已归属/);
}));
test('HTTP日志接口和AI读取同样强制会话，scope=all无法放宽文件读取', () => fixture(async library => {
  const routes = new Map(); registerRoutes({ effect(fn) { fn(); }, connection: { fetch: { register(route) { routes.set(route.path, route); } } } }, { logLibrary: library });
  const file = await upload(library, A);
  for (const endpoint of ['list', 'info', 'logs', 'source', 'export', 'usage', 'trash', 'unassigned']) {
    const route = routes.get('/api/dsh-e2e/log-library/' + endpoint), missing = await route.fetch(new Request('http://localhost/api/dsh-e2e/log-library/' + endpoint + '?id=' + file.id)); assert.ok(missing.status >= 400, endpoint);
    if (['info', 'logs', 'source', 'export'].includes(endpoint)) { const foreign = await route.fetch(new Request('http://localhost/api/dsh-e2e/log-library/' + endpoint + '?sessionId=session-B&scope=all&id=' + file.id)); assert.ok(foreign.status >= 400, endpoint); }
  }
}));
test('分析草稿保留已有文字，拒绝覆盖引用或正在提交的内容，不自动发送', () => {
  let draft, sends = 0; const input = { state: { getSnapshot: () => ({ phase: 'plain', draft: '已有问题', occurrences: [] }) }, setDraft(text) { draft = text; }, submit() { sends++; } };
  appendLogDraft(input, '日志分析'); assert.equal(draft, '已有问题\n\n日志分析'); assert.equal(sends, 0);
  input.state.getSnapshot = () => ({ phase: 'plain', draft: '文件引用', occurrences: [{}] }); assert.throws(() => appendLogDraft(input, '覆盖'), /引用/); assert.equal(draft, '已有问题\n\n日志分析');
  const prompt = logAnalysisPrompt({ id: 'file', name: 'test.log' }, { sourceLine: 50, raw: 'unknown' }, { query: 'error' }); assert.match(prompt, /原文件行号：50/); assert.match(prompt, /日志内容：unknown/); assert.match(prompt, /只分析日志/); assert.match(prompt, /问题：$/); assert.doesNotMatch(prompt, /e2e_phone|get_file_logs|"operation"|筛选范围/);
  const filePrompt = logAnalysisPrompt({ id: 'file', name: 'test.log', sourceKind: 'realtime' }, undefined, { tag: 'Network', regex: true, query: '' }); assert.match(filePrompt, /筛选范围：TAG=Network，正则=开启/); assert.doesNotMatch(filePrompt, /e2e_phone|get_file_logs|"operation"/);
});
test('浏览器分块导入失败会取消原上传，新的重试可完整写入且只绑定指定会话', () => fixture(async library => {
  const previous = globalThis.fetch; let broken = true, aborts = 0;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url, 'http://localhost'), op = parsed.pathname.split('/').at(-1), scope = { sessionId: parsed.searchParams.get('sessionId') }, body = options.headers?.['content-type'] === 'application/json' ? JSON.parse(options.body) : undefined;
    if (op === 'chunk' && broken) { broken = false; return Response.json({ error: '暂时写入失败' }, { status: 400 }); }
    const result = op === 'begin' ? await library.begin(body, scope) : op === 'chunk' ? await library.chunk(parsed.searchParams.get('id'), +parsed.searchParams.get('index'), Buffer.from(options.body), scope) : op === 'finish' ? await library.finish(body.id, scope) : (aborts++, await library.abort(body.id, scope)); return Response.json(result);
  };
  try { const file = new File([sample], 'retry.log'); await assert.rejects(importLogFile(file, A.sessionId), /写入失败/); assert.equal(aborts, 1); const finished = await importLogFile(file, A.sessionId); assert.equal((await library.list(0, 20, A)).total, 1); assert.equal((await library.list(0, 20, B)).total, 0); assert.equal(finished.sha256, createHash('sha256').update(sample).digest('hex')); } finally { globalThis.fetch = previous; }
}));

test('宿主 synthetic URL 通过原 Host 校验同源写入，跨源仍拒绝', async () => {
 const req = origin => new Request('http://dsh.internal/api/example', {method:'POST',headers:{origin,host:'127.0.0.1:55397'},body:'{}'});
 assert.deepEqual(await mutationBody(req('http://127.0.0.1:55397')),{});
 await assert.rejects(mutationBody(req('http://evil.example')), /来源/);
 await assert.rejects(mutationBody(req('http://127.0.0.1:9999')), /来源/);
 await assert.rejects(mutationBody(req('https://127.0.0.1:55397')), /来源/);
});

test('flat session list includes legacy groups; selection analysis rejects other sessions',()=>fixture(async library=>{
 const group=await library.createGroup('legacy',A);const one=await upload(library,A,'grouped.log',sample,{groupId:group.id});const two=await upload(library,A,'flat.log');
 assert.equal((await library.list(0,20,A)).total,2);const result=await library.analysis({ids:[one.id,two.id]},A);assert.equal(result.files.length,2);
 await assert.rejects(library.analysis({ids:[one.id]},B));await assert.rejects(library.analysis({ids:[one.id,one.id]},A),/不同/);
}));
