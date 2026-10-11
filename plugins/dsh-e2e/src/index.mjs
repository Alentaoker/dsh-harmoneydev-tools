import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { createService, inside } from './service.mjs';
export const name = 'dshE2E';
export const inject = ['connection', 'sessions', 'llm', 'dshHarmony'];
export function apply(ctx) {
  const service = createService(ctx);
  ctx.effect(() => ctx.reflect.provide('dshE2E', service), 'dshE2E: service');
  ctx.effect(() => () => service.dispose(), 'dshE2E: cleanup');
  for (const [path, methods, handler] of [
    ['/api/dsh-e2e/status', ['GET'], () => service.status()],
    ['/api/dsh-e2e/runs', ['GET'], async () => ({ runs: await service.list() })],
    ['/api/dsh-e2e/report', ['GET'], async request => { const job = await service.get(new URL(request.url).searchParams.get('id')); let report; try { report = JSON.parse(await readFile(inside(job.directory, 'e2e/report.json'), 'utf8')); } catch {} return { run: service.summary(job), report, logCollection: job.logCollection, logs: job.logs || [] }; }],
    ['/api/dsh-e2e/logs', ['GET'], async request => { const p = new URL(request.url).searchParams; return service.getLogs(p.get('id'), { offset: p.has('offset') ? Number(p.get('offset')) : undefined, limit: p.has('limit') ? Number(p.get('limit')) : undefined, level: p.get('level') || undefined, query: p.get('query') || undefined }); }],
    ['/api/dsh-e2e/cancel', ['POST'], async request => { const origin = request.headers.get('origin'); if (origin && origin !== new URL(request.url).origin && origin !== 'null') throw new Error('请求来源不匹配'); const body = await request.json(); return service.cancel(body.id); }],
  ]) ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', async fetch(request) { try { return Response.json(await handler(request)); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); } } }), `dshE2E: ${path}`);
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-e2e/artifact', methods: ['GET'], async fetch(request) {
    try { const params = new URL(request.url).searchParams, job = await service.get(params.get('id')), file = params.get('file') || 'e2e/summary.md'; if (!/\.(md|json|jsonl|png|xml|log)$/.test(file)) throw new Error('文件类型不允许'); const path = inside(job.directory, file); const data = await readFile(path); return new Response(data, { headers: { 'content-type': file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
    catch (error) { return Response.json({ error: error.message }, { status: 404 }); }
  } }), 'dshE2E: artifacts');
}
