import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
const output = new URL('./.session-log-save.mjs', import.meta.url);
await build({ entryPoints: ['src/log-session.ts'], bundle: true, platform: 'node', format: 'esm', external: ['react'], outfile: fileURLToPath(output) });
const { saveSessionLog } = await import(output.href);
test.after(() => rm(output, { force: true }));
test('旧版或缺失E2E不会写入全局日志库；正常文件保存无此依赖', async () => {
  const previous = globalThis.fetch, calls = []; globalThis.fetch = async url => { calls.push(url); return Response.json({ storage: 'global' }); };
  try { await assert.rejects(saveSessionLog(new File(['line'], 'phone.log'), 'session-A', {}, new AbortController().signal), /新版/); assert.equal(calls.length, 1); assert.ok(calls[0].includes('/capabilities?sessionId=session-A')); } finally { globalThis.fetch = previous; }
});
test('实时快照分块保存、元数据及目标会话固定，不依赖手机控制或模型', async () => {
  const previous = globalThis.fetch, calls = [], bytes = [], snapshot = { bundle: 'test.app', count: 12, dropped: 2, evicted: 4 };
  globalThis.fetch = async (url, options = {}) => { const parsed = new URL(url, 'http://localhost'), operation = parsed.pathname.split('/').at(-1); calls.push({ operation, sessionId: parsed.searchParams.get('sessionId'), body: options.headers?.['content-type'] === 'application/json' ? JSON.parse(options.body) : undefined }); if (operation === 'capabilities') return Response.json({ protocolVersion: 2, sessionId: 'session-A' }); if (operation === 'begin') return Response.json({ id: 'upload-id' }); if (operation === 'chunk') { bytes.push(Buffer.from(options.body)); return Response.json({}); } return Response.json({ id: 'saved-id' }); };
  try { const file = new File(['x'.repeat(262144), '中文尾部'], 'phone.log'); const result = await saveSessionLog(file, 'session-A', snapshot, new AbortController().signal); assert.equal(result.id, 'saved-id'); assert.deepEqual(calls.map(c => c.operation), ['capabilities', 'begin', 'chunk', 'chunk', 'finish']); assert.ok(calls.every(c => c.sessionId === 'session-A')); assert.deepEqual(calls[1].body.snapshot, snapshot); assert.deepEqual(Buffer.concat(bytes), Buffer.from(await file.arrayBuffer())); assert.ok(bytes.every(b => b.length <= 262144)); } finally { globalThis.fetch = previous; }
});
