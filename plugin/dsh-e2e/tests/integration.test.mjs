import './profile-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, inside, RETIRED_OPERATIONS } from '../src/service.mjs';
import { convertSnapshot, roleFor, geometryRecord, assertGeometry, toNativePoint, snapshotQuality } from '../src/snapshot.mjs';
import { validateToolCall } from '../src/tool-contract.mjs';

test('鸿蒙节点转换：稳定 ID、失效节点与密码脱敏（无第三方 engine 依赖）', () => {
  const s = { generation: 1, quality: { appId: 'test', treeStatus: 'valid', scopeComplete: true }, nodes: [{ ref: 'a', id: 'input', type: 'TextInput', text: 'one', bounds: { left: 0, top: 0, right: 100, bottom: 40 } }, { ref: 'b', id: 'password', type: 'TextInput', text: 'private', hint: '密码' }] };
  const first = convertSnapshot(s, { width: 100, height: 100 });
  const second = convertSnapshot({ ...s, nodes: s.nodes.map(n => ({ ...n, ref: 'next-' + n.ref, text: 'two' })) }, { width: 100, height: 100 });
  assert.equal(first.snapshot.root.children[0].ref.id, second.snapshot.root.children[0].ref.id);
  assert.equal(first.snapshot.root.children[1].text, ''); assert.equal(first.snapshot.root.children[1].value, undefined);
  assert.equal(first.snapshot.root.children[1].states.secure, true);
  assert.equal(roleFor({ type: 'Button', clickable: true }), 'button');
  assert.equal(roleFor({ type: 'TextInput' }), 'textbox');
});

test('几何契约：原生/帧尺寸分开、过期观察拒绝换算、空控件树不算已目视验证', () => {
  const record = geometryRecord({ generation: 7, revision: 3, capturedAt: '2026-10-18T00:00:00.000Z', screenshot: { width: 360, height: 800 }, quality: { treeStatus: 'valid', scopeComplete: true } }, { nativeWidth: 1080, nativeHeight: 2400, orientation: 'portrait' });
  assert.equal(record.nativeSize.width, 1080); assert.equal(record.displaySize.width, 360);
  assert.equal(record.scale.x, 3); assert.equal(record.coordinateSpace, 'native');
  assert.deepEqual(toNativePoint({ x: 10, y: 10 }, record), { x: 30, y: 30 });
  assert.throws(() => assertGeometry(record, { generation: 8 }), /过期/);
  assert.throws(() => assertGeometry(record, { geometryId: 'other' }), /几何信息已变化/);
  assert.throws(() => geometryRecord({ quality: {} }, {}), /原生几何/);
  const quality = snapshotQuality({ quality: { treeStatus: 'unavailable', scopeComplete: false } });
  assert.equal(quality.complete, false); assert.equal(quality.visualInspected, false); assert.equal(quality.reasons.length, 1);
});

test('报告目录边界：拒绝 ..、绝对路径和空相对路径', () => {
  assert.throws(() => inside('E:/report', '../credentials.json'), /超出/);
  assert.throws(() => inside('E:/report', 'E:/Windows/win.ini'), /超出/);
  assert.throws(() => inside('E:/report', ''), /超出/);
  assert.equal(inside('E:/report', 'e2e/summary.md').endsWith('summary.md'), true);
});

test('旧的执行操作只有退役说明，不会悄悄转成新动作', () => {
  for (const operation of ['run', 'replay', 'retry', 'cancel', 'archive']) {
    assert.equal(typeof RETIRED_OPERATIONS[operation], 'string');
    assert.match(RETIRED_OPERATIONS[operation], /移除|退役/);
    assert.doesNotThrow(() => validateToolCall({ operation, ...({ run: { goal: 'x' }, replay: { id: 'x' }, retry: { id: 'x' }, cancel: { id: 'x' }, archive: { id: 'x' } })[operation] }), `${operation} 的旧字段应落到迁移错误，而不是 schema 拒绝`);
  }
  assert.throws(() => validateToolCall({ operation: 'save_task', title: 'x', milliseconds: 1 }), /不接受字段/);
  assert.throws(() => validateToolCall({ operation: 'unknown' }), /不支持/);
});

test('没有 dshHarmony 也能构造服务：状态报告缺设备能力，不 eager 崩溃', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-service-'));
  const service = createService({}, root);
  try {
    const status = await service.status({ sessionId: 'unit' });
    assert.equal(status.harmonyReady, false);
    assert.equal(status.plugin, 'dshE2E');
    assert.equal(status.format, 'validation-v1');
    assert.deepEqual(status.devices, []);
    assert.equal((await service.listPage({ sessionId: 'unit' })).total, 0);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});
