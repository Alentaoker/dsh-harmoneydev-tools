import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLogLibrary } from '../src/log-library.mjs';
import { listLogSessionLabels } from '../src/log-management.mjs';
import { registerRoutes } from '../src/index.mjs';
import { legacyTrashFixture } from './legacy-trash-fixture.mjs';

const A = { sessionId: 'session-A' }, B = { sessionId: 'session-B' }, C = { sessionId: 'session-C' };
const hash = value => createHash('sha256').update(value).digest('hex');
const sample = '10-20 01:02:03.004 61 62 I C04707 Work: private-log-content\n';
async function upload(library, scope, name = 'device.log') {
  const data = Buffer.from(sample), value = await library.begin({ name, size: data.length }, scope);
  await library.chunk(value.id, 0, data, scope); return library.finish(value.id, scope);
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-log-management-'));
  const library = createLogLibrary(root, { listSessions: () => [{ id: A.sessionId, header: { name: '小艺开发' } }, { id: B.sessionId, name: '设置验证' }] });
  try { await run(library, root); } finally { await library.dispose(); await rm(root, { recursive: true, force: true }); }
}
const execute = (library, plan, scope = A) => library.management.execute({ token: plan.token, confirm: true }, scope);

test('宿主名称从实时/冷会话的标题投影读取，不依赖 header.name 或激活会话', async () => {
  const live = { id: A.sessionId, header: { id: A.sessionId } }, cold = { header: { id: B.sessionId } };
  const services = {
    sessionQuery: { listSessions: async () => [cold, { header: { id: A.sessionId } }] },
    sessionProjections: { cachedSnapshot: value => { assert.equal(value, live); return { values: { title: '实时会话名称' } }; } },
    sessionProjectionCache: { cachedSnapshot: header => { assert.equal(header.id, B.sessionId); return { values: { title: '未打开会话名称' } }; } },
  };
  const rows = await listLogSessionLabels({ sessions: { list: () => [live], get: id => id === live.id ? live : undefined }, reflect: { get: name => services[name] } });
  assert.equal(rows.find(row => row.id === A.sessionId).name, '实时会话名称');
  assert.equal(rows.find(row => row.id === B.sessionId).name, '未打开会话名称');
  const fallback = await listLogSessionLabels({ sessions: { list: () => [{ id: 'old', header: { name: '旧宿主名称' } }] } });
  assert.equal(fallback[0].name, '旧宿主名称');
});

test('管理入口汇总多会话及仅旧删除残留会话，提供名称和占用但不返回正文', () => fixture(async (library, root) => {
  const a = await upload(library, A), b = await upload(library, B), c = await upload(library, C);
  await legacyTrashFixture(root, B, [b.id]);
  const page = await library.management.sessions({}, A);
  assert.equal(page.total, 3); assert.equal(page.totals.files, 2); assert.equal(page.totals.trashFiles, 1);
  assert.equal(page.sessions.find(row => row.sessionId === A.sessionId).name, '小艺开发');
  assert.equal(page.sessions.find(row => row.sessionId === B.sessionId).name, '设置验证');
  assert.equal(page.sessions.find(row => row.sessionId === C.sessionId).nameAvailable, false);
  assert.ok(page.totals.bytes >= a.size + c.size); assert.doesNotMatch(JSON.stringify(page), /private-log-content/);
  assert.equal((await library.management.sessions({ query: '小艺', limit: 1 }, A)).total, 1);
  const one = await library.management.sessions({ limit: 1 }, A); assert.equal(one.nextOffset, 1);
  await assert.rejects(library.management.sessions({}, {}), /会话/);
  await assert.rejects(library.management.sessions({ offset: -1 }, A), /参数/);
}));

test('批量永久删除冻结当前文件和旧残留ID，保留后来导入、后来残留及未选会话', () => fixture(async (library, root) => {
  const a = await upload(library, A), b = await upload(library, B), c = await upload(library, C);
  const old = await upload(library, A, 'old.log'); const legacy = await legacyTrashFixture(root, A, [old.id]);
  const aSource = await library.source(a.id, A), bSource = await library.source(b.id, B);
  const plan = await library.management.prepare({ action: 'delete', sessionIds: [A.sessionId, B.sessionId] }, A);
  assert.equal(plan.count, 3); assert.equal(plan.sessionCount, 2);
  const later = await upload(library, A, 'later.log');
  const laterOld = await upload(library, A, 'later-old.log'); await legacyTrashFixture(root, A, [laterOld.id]);
  const result = await execute(library, plan); assert.equal(result.removed, 3); assert.deepEqual(result.errors, []);
  assert.equal((await library.list(0, 20, A)).files[0].id, later.id);
  assert.equal((await library.info(c.id, C)).id, c.id); assert.equal((await library.list(0, 20, B)).total, 0);
  await assert.rejects(readFile(aSource.path), /ENOENT/); await assert.rejects(readFile(bSource.path), /ENOENT/);
  await assert.rejects(readFile(join(legacy.directory, old.id, 'library.json')), /ENOENT/);
  assert.deepEqual((await library.trash(0, 20, A)).files.map(file => file.id), [laterOld.id]);
  assert.equal((await library.trash(0, 20, B)).total, 0);
  await assert.rejects(library.info(b.id, A));
}));

test('永久删除只清空确认时选中的回收文件，后来的回收文件和其他会话保留', () => fixture(async (library, root) => {
  const a = await upload(library, A), b = await upload(library, B);
  const first = await legacyTrashFixture(root, A, [a.id]); await legacyTrashFixture(root, B, [b.id]);
  const plan = await library.management.prepare({ action: 'purge', sessionIds: [A.sessionId] }, A);
  const later = await upload(library, A, 'later.log'); await legacyTrashFixture(root, A, [later.id]);
  const result = await execute(library, plan); assert.equal(result.removed, 1); assert.deepEqual(result.errors, []);
  await assert.rejects(readFile(join(root, 'log-library', 'trash', hash(A.sessionId), first.batchId, a.id, 'source.log')), /ENOENT/);
  assert.equal((await library.trash(0, 20, A)).files[0].id, later.id);
  assert.equal((await library.trash(0, 20, B)).files[0].id, b.id);
}));

test('旧兼容管理令牌仍绑定入口会话且只能使用一次，不新建回收文件', () => fixture(async (library, root) => {
  const a = await upload(library, A);
  const plan = await library.management.prepare({ action: 'delete', sessionIds: [A.sessionId] }, A);
  await assert.rejects(library.management.execute({ token: plan.token }, A), /确认/);
  await assert.rejects(execute(library, plan, B), /范围/);
  const attempts = await Promise.allSettled([execute(library, plan), execute(library, plan)]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  await assert.rejects(library.info(a.id, A)); assert.equal((await library.trash(0, 20, A)).total, 0);
  const old = await upload(library, A, 'old.log'); await legacyTrashFixture(root, A, [old.id]);
  const expired = await library.management.prepare({ action: 'restore', sessionIds: [A.sessionId] }, A);
  const realNow = Date.now;
  try { Date.now = () => realNow() + 10 * 60000 + 1; await assert.rejects(execute(library, expired), /过期/); }
  finally { Date.now = realNow; }
  assert.equal((await library.trash(0, 20, A)).total, 1);
  await assert.rejects(library.management.prepare({ action: 'delete', sessionIds: ['../../Data'] }, A), /没有/);
  await assert.rejects(library.management.prepare({ action: 'delete', sessionIds: Array(201).fill(A.sessionId) }, A), /200/);
}));

test('导入中的会话跳过，其他所选会话仍完成；结束导入后可以重试清理', () => fixture(async library => {
  const a = await upload(library, A), b = await upload(library, B);
  const plan = await library.management.prepare({ action: 'delete', sessionIds: [A.sessionId, B.sessionId] }, A);
  const pending = await library.begin({ name: 'pending.log', size: 1 }, A);
  const result = await execute(library, plan); assert.equal(result.removed, 1); assert.equal(result.errors.length, 1); assert.match(result.errors[0].error, /导入/);
  assert.equal((await library.info(a.id, A)).id, a.id); await assert.rejects(library.info(b.id, B)); assert.equal((await library.trash(0, 20, B)).total, 0);
  await library.abort(pending.id, A);
  const retry = await library.management.prepare({ action: 'delete', sessionIds: [A.sessionId] }, A);
  assert.equal((await execute(library, retry)).removed, 1);
}));

test('正在执行清理的会话不能开始新导入，完成后释放占用', () => fixture(async library => {
  await upload(library, A); const plan = await library.management.prepare({ action: 'delete', sessionIds: [A.sessionId] }, A);
  const original = library.remove; let entered; const started = new Promise(resolve => { entered = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
  library.remove = async (...args) => { entered(); await gate; return original(...args); };
  const operation = execute(library, plan); await started;
  try { await assert.rejects(library.begin({ name: 'during.log', size: 1 }, A), /清理/); }
  finally { release(); }
  assert.equal((await operation).removed, 1);
  const pending = await library.begin({ name: 'after.log', size: 1 }, A); await library.abort(pending.id, A);
}));

test('确认后改名的文件被跳过；不将变化后的文件算作已清理', () => fixture(async library => {
  const a = await upload(library, A); const plan = await library.management.prepare({ action: 'delete', sessionIds: [A.sessionId] }, A);
  await library.rename(a.id, 'new-name.log', A);
  const result = await execute(library, plan); assert.equal(result.removed, 0); assert.equal(result.errors.length, 1);
  assert.equal((await library.info(a.id, A)).name, 'new-name.log');
}));

test('损坏/伪造归属记录与未归属旧库不加入批量清理', () => fixture(async (library, root) => {
  const b = await upload(library, B), legacyId = randomUUID(), fakeId = randomUUID();
  const legacy = join(root, 'log-library', legacyId); await mkdir(legacy); await writeFile(join(legacy, 'library.json'), JSON.stringify({ id: legacyId, status: 'ready', name: 'old.log', size: 1 })); await writeFile(join(legacy, 'source.log'), 'x');
  const forged = join(root, 'log-library', 'sessions', hash(A.sessionId), fakeId); await mkdir(forged, { recursive: true });
  await writeFile(join(forged, 'library.json'), JSON.stringify({ id: fakeId, sessionId: B.sessionId, status: 'ready', size: 1 }));
  const page = await library.management.sessions({}, A); assert.equal(page.total, 1); assert.equal(page.sessions[0].sessionId, B.sessionId);
  const plan = await library.management.prepare({ action: 'delete', sessionIds: [B.sessionId] }, A); await execute(library, plan);
  await assert.rejects(library.info(b.id, B)); assert.equal((await library.trash(0, 20, B)).total, 0);
  assert.equal(await readFile(join(legacy, 'source.log'), 'utf8'), 'x'); assert.ok(await readFile(join(forged, 'library.json')));
}));

test('会话目录的链接不被管理入口扫描或删除', async t => fixture(async (library, root) => {
  const b = await upload(library, B), parent = join(root, 'log-library', 'sessions');
  try { await symlink(join(parent, hash(B.sessionId)), join(parent, hash(A.sessionId)), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('环境不允许创建目录链接'); return; } throw error; }
  const page = await library.management.sessions({}, A); assert.equal(page.total, 1); assert.equal(page.sessions[0].sessionId, B.sessionId);
  assert.equal((await library.info(b.id, B)).id, b.id);
}));

test('真实 HTTP 注册链路提供独立管理入口，原会话读取仍隔离且写入拒绝跨源', () => fixture(async library => {
  const b = await upload(library, B), routes = new Map(); registerRoutes({ effect: fn => fn(), connection: { fetch: { register(route) { routes.set(route.path, route); } } } }, { logLibrary: library });
  const route = path => routes.get('/api/dsh-e2e/log-library/' + path);
  const get = path => new Request('http://localhost/api/dsh-e2e/log-library/' + path);
  const post = (path, body, origin = 'http://localhost') => new Request('http://localhost/api/dsh-e2e/log-library/' + path + '?sessionId=' + A.sessionId, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await route('management/sessions').fetch(get('management/sessions'))).status, 400);
  const list = await route('management/sessions').fetch(get('management/sessions?sessionId=session-A')); assert.equal((await list.json()).total, 1);
  const foreign = await route('info').fetch(get('info?sessionId=session-A&scope=all&id=' + b.id)); assert.equal(foreign.status, 400);
  const body = { action: 'delete', sessionIds: [B.sessionId] };
  assert.equal((await route('management/prepare').fetch(post('management/prepare', body, 'http://evil.example'))).status, 400);
  const prepared = await route('management/prepare').fetch(post('management/prepare', body)); assert.equal(prepared.status, 200); const plan = await prepared.json();
  assert.equal((await route('management/execute').fetch(post('management/execute', { token: plan.token }))).status, 400);
  const deleted = await route('management/execute').fetch(post('management/execute', { token: plan.token, confirm: true })); assert.equal((await deleted.json()).removed, 1);
}));

test('一键删除 HTTP 无文字确认且清理所选会话旧残留，单会话删除仍拒绝越权与跨源', () => fixture(async (library, root) => {
  const a = await upload(library, A), b = await upload(library, B), old = await upload(library, B, 'old.log');
  await legacyTrashFixture(root, B, [old.id]);
  const routes = new Map(); registerRoutes({ effect: fn => fn(), connection: { fetch: { register(route) { routes.set(route.path, route); } } } }, { logLibrary: library });
  const post = (endpoint, body, origin = 'http://localhost') => routes.get('/api/dsh-e2e/log-library/' + endpoint).fetch(new Request('http://localhost/api/dsh-e2e/log-library/' + endpoint + '?sessionId=' + A.sessionId, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await post('delete-permanently', { ids: [b.id] })).status, 400);
  assert.equal((await post('management/delete', { sessionIds: [B.sessionId] }, 'http://evil.example')).status, 400);
  const response = await post('management/delete', { sessionIds: [B.sessionId] }); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.removed, 2); assert.deepEqual(result.errors, []);
  assert.equal((await library.trash(0, 20, B)).total, 0); assert.equal((await library.info(a.id, A)).id, a.id);
  const deleted = await post('delete-permanently', { ids: [a.id] }); assert.equal(deleted.status, 200); assert.equal((await deleted.json()).permanent, true);
  const next = await upload(library, A, 'next.log'); const oldRoute = await post('delete', { ids: [next.id] }); assert.equal(oldRoute.status, 200); assert.equal((await oldRoute.json()).permanent, true);
}));
