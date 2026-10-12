import { readFile, realpath, stat } from 'node:fs/promises';
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
    ['/api/dsh-e2e/status', ['GET'], request => service.status(requestScope(request))],
    ['/api/dsh-e2e/runs', ['GET'], request => { const p = new URL(request.url).searchParams; return service.listPage({ ...requestScope(request), offset: p.get('offset') || 0, limit: p.get('limit') || 20, query: p.get('query') || '', status: p.get('status') || undefined, archived: p.get('archived') === 'true' }); }],
    ['/api/dsh-e2e/report', ['GET'], request => service.report(new URL(request.url).searchParams.get('id'), requestScope(request))],
    ['/api/dsh-e2e/logs', ['GET'], request => { const p = new URL(request.url).searchParams; return service.getLogs(p.get('id'), { offset: p.get('offset') || 0, limit: p.get('limit') || 100, level: p.get('level') || undefined, query: p.get('query') || '', from: p.get('from'), until: p.get('until') }, requestScope(request)); }],
    ['/api/dsh-e2e/cancel', ['POST'], async request => { const body = await mutationBody(request); return service.cancel(body.id, requestScope(request, true)); }],
    ['/api/dsh-e2e/archive', ['POST'], async request => { const body = await mutationBody(request); if (typeof body.archived !== 'boolean') throw new Error('归档参数无效'); return service.archive(body.id, body.archived, requestScope(request, true)); }],
  ]) ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', async fetch(request) { try { return Response.json(await handler(request), { headers: { 'cache-control': 'no-store' } }); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); } } }), `dshE2E: ${path}`);
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-e2e/artifact', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try {
      const p = new URL(request.url).searchParams, job = await service.get(p.get('id'), requestScope(request)), file = p.get('file') || 'e2e/summary.md';
      if (!/\.(md|json|jsonl|png|xml|log|txt)$/i.test(file)) throw new Error('文件类型不允许');
      const root = await realpath(job.directory), path = await realpath(inside(root, file)); inside(root, path);
      if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('文件过大，请在本机报告目录查看');
      return new Response(await readFile(path), { headers: { 'content-type': file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch (error) { return Response.json({ error: error.message }, { status: 404 }); }
  } }), 'dshE2E: artifacts');
}
export async function mutationBody(request) {
  const origin = request.headers.get('origin'); if (origin && origin !== new URL(request.url).origin && origin !== 'null') throw new Error('请求来源不匹配');
  const text = await request.text(); if (text.length > 4096) throw new Error('请求过大'); return JSON.parse(text);
}
