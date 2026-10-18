import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createValidationStore, sessionKey } from '../src/validation-store.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-validation-'));
  try { await run({ root, store: createValidationStore(root) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const task = (taskId, revision) => ({ taskId, expectedRevision: revision, title: '日志崩溃', kind: 'bug', requirement: '应用启动后崩溃', checkpoints: [{ id: 'cp1', description: '首页可见', required: true }] });

test('会话隔离：任务目录按会话键分隔，跨会话读不到', () => fixture(async ({ store }) => {
  await store.saveTask('session-A', task('task-aaaaaaaa', undefined));
  assert.equal((await store.listTasks('session-A')).length, 1);
  assert.equal((await store.listTasks('session-B')).length, 0);
  await assert.rejects(() => store.readTask('session-B', 'task-aaaaaaaa'), /找不到/);
  assert.notEqual(sessionKey('session-A'), sessionKey('session-B'));
  assert.match(sessionKey('session-A'), /^[a-f0-9]{32}$/);
}));

test('revision 冲突：旧 revision 不能覆盖新结果，创建不能冒用已有 revision', () => fixture(async ({ store }) => {
  const first = await store.saveTask('s', task('task-aaaaaaaa', undefined));
  assert.equal(first.revision, 1);
  await assert.rejects(() => store.saveTask('s', task('task-aaaaaaaa', undefined)), /任务已被更新|不能按已有 revision 更新/);
  const second = await store.saveTask('s', task('task-aaaaaaaa', 1));
  assert.equal(second.revision, 2);
  await assert.rejects(() => store.saveTask('s', task('task-aaaaaaaa', 1)), (error) => error.code === 'REVISION_CONFLICT');
  assert.equal((await store.readTask('s', 'task-aaaaaaaa')).revision, 2);
}));

test('事件追加：seq 单调、游标分页不重不漏、崩溃半行只读完整事件', () => fixture(async ({ store, root }) => {
  await store.saveTask('s', task('task-aaaaaaaa', undefined));
  await store.createAttempt('s', 'task-aaaaaaaa', { attemptId: 'attempt-aaaaaaaa', taskId: 'task-aaaaaaaa', taskRevision: 1, execution: 'active' });
  for (let index = 0; index < 5; index++) await store.appendEvent('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', { revision: 1, type: 'tool-start', data: { index } });
  const first = await store.readEvents('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', { afterSeq: 0, limit: 2 });
  assert.deepEqual(first.events.map(event => event.seq), [1, 2]);
  assert.equal(first.nextAfterSeq, 2);
  assert.equal(first.hasMore, true);
  const second = await store.readEvents('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', { afterSeq: first.nextAfterSeq, limit: 2 });
  assert.deepEqual(second.events.map(event => event.seq), [3, 4]);
  const third = await store.readEvents('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', { afterSeq: second.nextAfterSeq, limit: 2 });
  assert.deepEqual(third.events.map(event => event.seq), [5]);
  assert.equal(third.hasMore, false);
  assert.equal(third.tailGap, false);

  const path = join(root, 'validation-v1', 'sessions', sessionKey('s'), 'tasks', 'task-aaaaaaaa', 'attempts', 'attempt-aaaaaaaa', 'events.jsonl');
  await appendFile(path, '{"seq":6,"type":"tool-end"');
  const afterCrash = await store.readEvents('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', { afterSeq: 5, limit: 10 });
  assert.equal(afterCrash.events.length, 0);
  assert.equal(afterCrash.tailGap, true);
  const next = await store.appendEvent('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', { revision: 1, type: 'tool-end' });
  assert.equal(next.seq, 6);
  const repaired = await store.readEvents('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', { afterSeq: 5, limit: 10 });
  assert.equal(repaired.events.length, 1);
  assert.equal(repaired.damaged >= 1, true, '半行作为损坏尾部报告，但已提交事件不被重写');
}));

test('证据文件：拒绝路径穿越、绝对路径和未知名字', () => fixture(async ({ store }) => {
  await store.saveTask('s', task('task-aaaaaaaa', undefined));
  await store.createAttempt('s', 'task-aaaaaaaa', { attemptId: 'attempt-aaaaaaaa', taskId: 'task-aaaaaaaa', taskRevision: 1, execution: 'active' });
  const saved = await store.writeEvidence('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', 'before.png', Buffer.from('png'));
  assert.equal(saved.name, 'before.png');
  assert.equal((await store.evidencePath('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', 'before.png')).endsWith('before.png'), true);
  for (const name of ['../escape.png', '..\\escape.png', 'a/b.png', 'C:\\x.png', '.hidden']) {
    await assert.rejects(() => store.writeEvidence('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', name, Buffer.from('x')), /证据文件名无效/);
  }
  await assert.rejects(() => store.evidencePath('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', 'missing.png'), /找不到该证据文件/);
}));

test('宿主重启只把新版 active 轮次标记中断，不动已结束记录', () => fixture(async ({ store }) => {
  await store.saveTask('s', task('task-aaaaaaaa', undefined));
  await store.createAttempt('s', 'task-aaaaaaaa', { attemptId: 'attempt-aaaaaaaa', taskId: 'task-aaaaaaaa', taskRevision: 1, execution: 'active' });
  await store.createAttempt('s', 'task-aaaaaaaa', { attemptId: 'attempt-bbbbbbbb', taskId: 'task-aaaaaaaa', taskRevision: 1, execution: 'finished', semantic: 'passed' });
  const recovered = await store.recoverInterrupted();
  assert.deepEqual(recovered.map(item => item.attemptId), ['attempt-aaaaaaaa']);
  assert.equal((await store.readAttempt('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa')).execution, 'interrupted');
  assert.equal((await store.readAttempt('s', 'task-aaaaaaaa', 'attempt-bbbbbbbb')).semantic, 'passed');
}));

test('R12：目录 junction 与文件软链读路径被拒绝（隔离夹具）', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-junction-'));
  const store = createValidationStore(root);
  try {
    await store.saveTask('s', task('task-aaaaaaaa', undefined));
    await store.createAttempt('s', 'task-aaaaaaaa', { attemptId: 'attempt-aaaaaaaa', taskId: 'task-aaaaaaaa', taskRevision: 1, execution: 'active' });
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'ev.png'), Buffer.from('outside'));
    const evidence = join(store.attemptDir('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa'), 'evidence');
    await rm(evidence, { recursive: true, force: true });
    try { await symlink(outside, evidence, 'junction'); }
    catch (error) { t.skip(`当前环境不能创建 junction：${error.code}`); return; }
    await assert.rejects(() => store.evidencePath('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', 'ev.png'), /越界|软链|找不到/);
    await assert.rejects(() => store.writeEvidence('s', 'task-aaaaaaaa', 'attempt-aaaaaaaa', 'ev.png', Buffer.from('x')), /越界|软链|找不到/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('损坏的 attempt.json 不遮挡其他记录', () => fixture(async ({ store }) => {
  await store.saveTask('s', task('task-aaaaaaaa', undefined));
  await store.createAttempt('s', 'task-aaaaaaaa', { attemptId: 'attempt-aaaaaaaa', taskId: 'task-aaaaaaaa', taskRevision: 1, execution: 'active' });
  const broken = join(store.root, 'sessions', sessionKey('s'), 'tasks', 'task-aaaaaaaa', 'attempts', 'attempt-badbadba');
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, 'attempt.json'), '{not json');
  const attempts = await store.listAttempts('s', 'task-aaaaaaaa');
  assert.deepEqual(attempts.map(item => item.attemptId), ['attempt-aaaaaaaa']);
}));
