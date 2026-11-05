import { TEXT_BYTES, PACKAGE_BYTES, EXPANDED_BYTES } from './log-limits.mjs';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createLogService } from './service.mjs';
export const name='dshLogAnalysis';
export const inject=['connection','sessions'];
export function requestScope(request) { const sessionId=new URL(request.url).searchParams.get('sessionId'); if(!sessionId||sessionId.length>256)throw Error('请在会话中打开日志分析'); return {sessionId}; }
export function apply(ctx) { const service=createLogService(ctx); ctx.effect(()=>()=>service.dispose(),'dshLogAnalysis: cleanup'); registerRoutes(ctx,service); }
const byteStream=source=>Readable.from((async function*(){for await(const chunk of source)yield typeof chunk==='string'?Buffer.from(chunk):chunk;})());
export function registerRoutes(ctx,service) {
 for(const [path,methods,handler] of [
    ['/api/dsh-log-analysis/log-library/capabilities', ['GET'], request => ({ protocolVersion: 2, features: ['groups', 'packages', 'blocks', 'favorites', 'analysis-paths', 'rar', 'text-encodings', 'cross-file-search', 'direct-delete'], limits: { textBytes: TEXT_BYTES, packageBytes: PACKAGE_BYTES, expandedBytes: EXPANDED_BYTES, pageLines: 1000 }, sessionId: requestScope(request, true).sessionId, storage: 'session', plugin: 'dshLogAnalysis' })],
    ['/api/dsh-log-analysis/log-library/management/sessions', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.management.sessions({ query: p.get('query') || '', offset: p.get('offset') || 0, limit: p.get('limit') || 50 }, requestScope(request, true)); }],
    ['/api/dsh-log-analysis/log-library/management/prepare', ['POST'], async request => service.logLibrary.management.prepare(await mutationBody(request, 64 * 1024), requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/management/execute', ['POST'], async request => service.logLibrary.management.execute(await mutationBody(request), requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/management/delete', ['POST'], async request => { const body = await mutationBody(request, 64 * 1024), scope = requestScope(request, true); const plan = await service.logLibrary.management.prepare({ action: 'delete', sessionIds: body.sessionIds }, scope); return service.logLibrary.management.execute({ token: plan.token, confirm: true }, scope); }],
    ['/api/dsh-log-analysis/log-library/groups', ['GET'], request => service.logLibrary.groups(requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/delete-group', ['POST'], async request => service.logLibrary.deleteGroup((await mutationBody(request)).id, requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/create-group', ['POST'], async request => service.logLibrary.createGroup((await mutationBody(request)).name, requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/rename-group', ['POST'], async request => { const body = await mutationBody(request); return service.logLibrary.renameGroup(body.id, body.name, requestScope(request, true)); }],
    ['/api/dsh-log-analysis/log-library/move', ['POST'], async request => { const body = await mutationBody(request, 512 * 1024); return service.logLibrary.move(body.ids, body.groupId, requestScope(request, true)); }],
    ['/api/dsh-log-analysis/log-library/preferences', ['GET', 'POST'], async request => service.logLibrary.preferences(requestScope(request, true), request.method === 'POST' ? await mutationBody(request) : undefined)],
    ['/api/dsh-log-analysis/log-library/analysis', ['POST'], async request => service.logLibrary.analysis(await mutationBody(request), requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/retry-package', ['POST'], async request => { const body = await mutationBody(request); return service.logLibrary.retryPackage(body.id, requestScope(request, true), body.encoding); }],
    ['/api/dsh-log-analysis/log-library/import-status', ['GET'], request => service.logLibrary.importStatus(new URL(request.url).searchParams.get('id'), requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/list', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.list(p.get('offset') || 0, p.get('limit') || 20, requestScope(request, true), { query: p.get('query') || '', sourceKind: p.get('sourceKind') || '', sort: p.get('sort') || 'newest', ...(p.has('groupId') ? { groupId: p.get('groupId') } : {}) }); }],
    ['/api/dsh-log-analysis/log-library/search', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.search(Object.fromEntries([...p].filter(([key]) => key !== 'sessionId')), requestScope(request, true), request.signal); }],
    ['/api/dsh-log-analysis/log-library/info', ['GET'], request => service.logLibrary.info(new URL(request.url).searchParams.get('id'), requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/select', ['POST'], async request => service.logLibrary.select(await mutationBody(request), requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/unassigned', ['GET'], request => service.logLibrary.unassigned(requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/trash', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.trash(p.get('offset') || 0, p.get('limit') || 20, requestScope(request, true)); }],
    ['/api/dsh-log-analysis/log-library/clear-analysis-cache', ['POST'], async request => { await mutationBody(request); return service.logLibrary.clearAnalysisCache(requestScope(request, true)); }],
    ['/api/dsh-log-analysis/log-library/usage', ['GET'], request => service.logLibrary.usage(requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/purge', ['POST'], async request => { const body = await mutationBody(request); if (body.confirm !== true) throw Error('请明确确认永久清空当前会话的回收区'); return service.logLibrary.purge(requestScope(request, true), body.before); }],
    ['/api/dsh-log-analysis/log-library/rename', ['POST'], async request => { const body = await mutationBody(request); return service.logLibrary.rename(body.id, body.name, requestScope(request, true)); }],
    ['/api/dsh-log-analysis/log-library/assign', ['POST'], async request => service.logLibrary.assign((await mutationBody(request)).id, requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/delete', ['POST'], async request => service.logLibrary.remove(await mutationBody(request, 512 * 1024), requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/delete-permanently', ['POST'], async request => service.logLibrary.remove(await mutationBody(request, 512 * 1024), requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/restore', ['POST'], async request => { const body = await mutationBody(request); return service.logLibrary.restore(body.batchId, requestScope(request, true), body.ids); }],
    ['/api/dsh-log-analysis/log-library/begin', ['POST'], async request => service.logLibrary.begin(await mutationBody(request), requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/chunk', ['POST'], async request => { const scope = requestScope(request, true); assertMutationOrigin(request); const p = new URL(request.url).searchParams; const length = Number(request.headers.get('content-length')); if (length > 262144) throw Error('日志分块过大'); const data = Buffer.from(await request.arrayBuffer()); return service.logLibrary.chunk(p.get('id'), Number(p.get('index')), data, scope); }],
    ['/api/dsh-log-analysis/log-library/finish', ['POST'], async request => service.logLibrary.finish((await mutationBody(request)).id, requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/abort', ['POST'], async request => service.logLibrary.abort((await mutationBody(request)).id, requestScope(request, true))],
    ['/api/dsh-log-analysis/log-library/logs', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.getLogs(p.get('id'), Object.fromEntries([...p].filter(([key]) => key !== 'id')), requestScope(request, true), request.signal); }],
 ])ctx.effect(()=>ctx.connection.fetch.register({path,methods,requestBody:'buffered',async fetch(request){try{return Response.json(await handler(request),{headers:{'cache-control':'no-store'}});}catch(error){return Response.json({error:error.message,code:error.code},{status:400});}}}),'dshLogAnalysis: '+path);
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/dsh-log-analysis/log-library/export',methods:['GET'],requestBody:'buffered',async fetch(request){try{const params=new URL(request.url).searchParams;const source=await service.logLibrary.export(params.get('id'),Object.fromEntries(params),requestScope(request));return new Response(Readable.toWeb(byteStream(source)),{headers:{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-store','content-disposition':'attachment; filename="filtered-logs.jsonl"','x-content-type-options':'nosniff'}});}catch(error){return Response.json({error:error.message},{status:404});}}}),'dshLogAnalysis: export');
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-log-analysis/log-library/source', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try { const value = await service.logLibrary.source(new URL(request.url).searchParams.get('id'), requestScope(request, true)); const source = createReadStream(value.path); return new Response(Readable.toWeb(value.compressed ? source.pipe(createGunzip()) : source), { headers: { 'content-type': /\.(zip|gz|rar)$/i.test(value.name) ? 'application/octet-stream' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(value.name), 'x-content-type-options': 'nosniff' } }); }
    catch (error) { return Response.json({ error: error.message }, { status: 404 }); }
  } }), 'dshLogAnalysis: original log');


}
export async function mutationBody(request, maximum = 4096) {
  assertMutationOrigin(request);
  const text = await request.text(); if (text.length > maximum) throw new Error('请求过大'); return JSON.parse(text);
}

// The authenticated DSH HTTP bridge uses a synthetic request URL and preserves Host.
// Compare the browser Origin with that authority, never with a forwarded header.
export function assertMutationOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return; // Desktop carrier compatibility.
  const target = new URL(request.url);
  const host = request.headers.get('host');
  const expected = target.hostname === 'dsh.internal' && host ? new URL(target.protocol + '//' + host).origin : target.origin;
  if (origin !== expected) throw new Error('请求来源不匹配');
}
