import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { exportLogStream } from './log-archive.mjs';
import { createService, inside } from './service.mjs';
export const name = 'dshE2E';
export const inject = ['connection', 'sessions', 'llm', 'dshHarmony'];
export function requestScope(request, write = false) {
  const p = new URL(request.url).searchParams, sessionId = p.get('sessionId');
  if (!sessionId || sessionId.length > 256) throw new Error('请在一个会话中打开 dshE2E');
  return { sessionId, all: !write && p.get('scope') === 'all' };
}
export function apply(ctx) {
  const service = createService(ctx);
  ctx.effect(() => ctx.reflect.provide('dshE2E', service), 'dshE2E: service');
  ctx.effect(() => () => service.dispose(), 'dshE2E: cleanup');
  registerRoutes(ctx, service);
}
export function registerRoutes(ctx, service) {
  for (const [path, methods, handler] of [
    ['/api/dsh-e2e/log-library/list', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.list(p.get('offset') || 0, p.get('limit') || 20); }],
    ['/api/dsh-e2e/log-library/begin', ['POST'], async request => service.logLibrary.begin(await mutationBody(request))],
    ['/api/dsh-e2e/log-library/chunk', ['POST'], async request => { const origin = request.headers.get('origin'); if (origin && origin !== new URL(request.url).origin && origin !== 'null') throw Error('请求来源不匹配'); const p = new URL(request.url).searchParams; const length = Number(request.headers.get('content-length')); if (length > 262144) throw Error('日志分块过大'); const data = Buffer.from(await request.arrayBuffer()); return service.logLibrary.chunk(p.get('id'), Number(p.get('index')), data); }],
    ['/api/dsh-e2e/log-library/finish', ['POST'], async request => service.logLibrary.finish((await mutationBody(request)).id)],
    ['/api/dsh-e2e/log-library/abort', ['POST'], async request => service.logLibrary.abort((await mutationBody(request)).id)],
    ['/api/dsh-e2e/log-library/logs', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.getLogs(p.get('id'), Object.fromEntries([...p].filter(([key]) => key !== 'id'))); }],
    ['/api/dsh-e2e/status', ['GET'], request => service.status(requestScope(request))],
    ['/api/dsh-e2e/runs', ['GET'], request => { const p = new URL(request.url).searchParams; return service.listPage({ ...requestScope(request), offset: p.get('offset') || 0, limit: p.get('limit') || 20, query: p.get('query') || '', status: p.get('status') || undefined, archived: p.get('archived') === 'true' }); }],
    ['/api/dsh-e2e/report', ['GET'], request => service.report(new URL(request.url).searchParams.get('id'), requestScope(request))],
    ['/api/dsh-e2e/logs', ['GET'], request => { const p = new URL(request.url).searchParams; return service.getLogs(p.get('id'), { offset: p.get('offset') || 0, limit: p.get('limit') || 100, level: p.get('level') || undefined, query: p.get('query') || '', tag: p.get('tag') || '', domain: p.get('domain') || '', pid: p.get('pid') || '', tid: p.get('tid') || '', regex: p.get('regex') === 'true', caseSensitive: p.get('caseSensitive') === 'true', fullMessage: p.get('fullMessage') === 'true', from: p.get('from'), until: p.get('until') }, requestScope(request)); }],
    ['/api/dsh-e2e/cancel', ['POST'], async request => { const body = await mutationBody(request); return service.cancel(body.id, requestScope(request, true)); }],
    ['/api/dsh-e2e/archive', ['POST'], async request => { const body = await mutationBody(request); if (typeof body.archived !== 'boolean') throw new Error('归档参数无效'); return service.archive(body.id, body.archived, requestScope(request, true)); }],
  ]) ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', async fetch(request) { try { return Response.json(await handler(request), { headers: { 'cache-control': 'no-store' } }); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); } } }), `dshE2E: ${path}`);
  for (const path of ['/api/dsh-e2e/log-export', '/api/dsh-e2e/log-library/export']) ctx.effect(() => ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try { const p = new URL(request.url).searchParams, options = Object.fromEntries(p); const source = path.includes('log-library') ? await service.logLibrary.export(p.get('id'), options) : await exportLogStream(await service.get(p.get('id'), requestScope(request)), options); return new Response(Readable.toWeb(Readable.from(source)), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="filtered-logs.jsonl"', 'x-content-type-options': 'nosniff' } }); }
    catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  } }), 'dshE2E: filtered log export ' + path);
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-e2e/log-library/source', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try { const value = await service.logLibrary.source(new URL(request.url).searchParams.get('id')); return new Response(Readable.toWeb(createReadStream(value.path)), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(value.name), 'x-content-type-options': 'nosniff' } }); }
    catch (error) { return Response.json({ error: error.message }, { status: 404 }); }
  } }), 'dshE2E: original log');
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-e2e/artifact', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try {
      const p = new URL(request.url).searchParams, job = await service.get(p.get('id'), requestScope(request)), file = p.get('file') || 'e2e/summary.md';
      if (!/\.(md|json|jsonl|png|xml|log|txt)$/i.test(file)) throw new Error('文件类型不允许');
      const root = await realpath(job.directory), path = await realpath(inside(root, file)); inside(root, path);
      if (file === 'app-logs.jsonl') { if ((await stat(path)).size > 128 * 1024 * 1024) throw Error('日志文件超过下载上限'); return new Response(Readable.toWeb(createReadStream(path)), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } }); }
      if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('文件过大，请在本机报告目录查看');
      return new Response(await readFile(path), { headers: { 'content-type': file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch (error) { return Response.json({ error: error.message }, { status: 404 }); }
  } }), 'dshE2E: artifacts');
}
export async function mutationBody(request) {
  const origin = request.headers.get('origin'); if (origin && origin !== new URL(request.url).origin && origin !== 'null') throw new Error('请求来源不匹配');
  const text = await request.text(); if (text.length > 4096) throw new Error('请求过大'); return JSON.parse(text);
}
