import { TEXT_BYTES, PACKAGE_BYTES, EXPANDED_BYTES } from './log-limits.mjs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { exportLogStream } from './log-archive.mjs';
import { createService, inside, retired } from './service.mjs';
export const name = 'dshE2E';
// dshHarmony is optional: the log workbench and history must stay usable when
// only dshE2E is installed, and dshHarmony must stay usable on its own.
// Cordis 4.0.4 treats every object key as a required service name; it does
// not accept a { required, optional } declaration. Optional services are read
// lazily, and the routing integration is a separate conditional child fiber.
export const inject = ['connection', 'sessions'];

export function requestScope(request, write = false) {
  const p = new URL(request.url).searchParams, sessionId = p.get('sessionId');
  if (!sessionId || sessionId.length > 256) throw new Error('请在一个会话中打开 dshVerify');
  return { sessionId, all: !write && p.get('scope') === 'all' };
}

export function apply(ctx) {
  const service = createService(ctx);
  const registerRouting = (routingCtx) => {
    // Coordination only: the routing layer knows which session has an active
    // attempt and whether it forbids control actions (human mode).
    routingCtx.effect(() => routingCtx.dshHarmony.automation.taskRouting.register({ activeAttempt: sessionId => service.validation.activeAttempt(sessionId) }), 'dshE2E: validation routing');
  };
  if (typeof ctx.inject === 'function') ctx.inject(['dshHarmony'], registerRouting);
  else if (ctx.dshHarmony?.automation?.taskRouting) registerRouting(ctx);
  ctx.effect(() => ctx.reflect.provide('dshE2E', service), 'dshE2E: service');
  ctx.effect(() => () => service.dispose(), 'dshE2E: cleanup');
  // Turn-stopping must NOT stop log capture: capture continues across AI replies.
  // Only an explicit stop, finish/cancel, session disposal or host disposal ends it.
  if (ctx.on) ctx.on('session/disposed', async (session) => { await service.validation.disposeSession(session.id); });
  registerRoutes(ctx, service);
}

export function registerRoutes(ctx, service) {
  for (const [path, methods, handler] of [
    ['/api/dsh-e2e/log-library/capabilities', ['GET'], request => ({ protocolVersion: 2, features: ['groups', 'packages', 'blocks', 'favorites', 'analysis-paths', 'rar', 'text-encodings', 'cross-file-search', 'direct-delete'], limits: { textBytes: TEXT_BYTES, packageBytes: PACKAGE_BYTES, expandedBytes: EXPANDED_BYTES, pageLines: 1000 }, sessionId: requestScope(request, true).sessionId, storage: 'session', plugin: 'dshE2E' })],
    ['/api/dsh-e2e/log-library/management/sessions', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.management.sessions({ query: p.get('query') || '', offset: p.get('offset') || 0, limit: p.get('limit') || 50 }, requestScope(request, true)); }],
    ['/api/dsh-e2e/log-library/management/prepare', ['POST'], async request => service.logLibrary.management.prepare(await mutationBody(request, 64 * 1024), requestScope(request, true))],
    ['/api/dsh-e2e/log-library/management/execute', ['POST'], async request => service.logLibrary.management.execute(await mutationBody(request), requestScope(request, true))],
    ['/api/dsh-e2e/log-library/management/delete', ['POST'], async request => { const body = await mutationBody(request, 64 * 1024), scope = requestScope(request, true); const plan = await service.logLibrary.management.prepare({ action: 'delete', sessionIds: body.sessionIds }, scope); return service.logLibrary.management.execute({ token: plan.token, confirm: true }, scope); }],
    ['/api/dsh-e2e/log-library/groups', ['GET'], request => service.logLibrary.groups(requestScope(request, true))],
    ['/api/dsh-e2e/log-library/delete-group', ['POST'], async request => service.logLibrary.deleteGroup((await mutationBody(request)).id, requestScope(request, true))],
    ['/api/dsh-e2e/log-library/create-group', ['POST'], async request => service.logLibrary.createGroup((await mutationBody(request)).name, requestScope(request, true))],
    ['/api/dsh-e2e/log-library/rename-group', ['POST'], async request => { const body = await mutationBody(request); return service.logLibrary.renameGroup(body.id, body.name, requestScope(request, true)); }],
    ['/api/dsh-e2e/log-library/move', ['POST'], async request => { const body = await mutationBody(request, 512 * 1024); return service.logLibrary.move(body.ids, body.groupId, requestScope(request, true)); }],
    ['/api/dsh-e2e/log-library/preferences', ['GET', 'POST'], async request => service.logLibrary.preferences(requestScope(request, true), request.method === 'POST' ? await mutationBody(request) : undefined)],
    ['/api/dsh-e2e/log-library/analysis', ['POST'], async request => service.logLibrary.analysis(await mutationBody(request), requestScope(request, true))],
    ['/api/dsh-e2e/log-library/retry-package', ['POST'], async request => { const body = await mutationBody(request); return service.logLibrary.retryPackage(body.id, requestScope(request, true), body.encoding); }],
    ['/api/dsh-e2e/log-library/import-status', ['GET'], request => service.logLibrary.importStatus(new URL(request.url).searchParams.get('id'), requestScope(request, true))],
    ['/api/dsh-e2e/log-library/list', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.list(p.get('offset') || 0, p.get('limit') || 20, requestScope(request, true), { query: p.get('query') || '', sourceKind: p.get('sourceKind') || '', sort: p.get('sort') || 'newest', ...(p.has('groupId') ? { groupId: p.get('groupId') } : {}) }); }],
    ['/api/dsh-e2e/log-library/search', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.search(Object.fromEntries([...p].filter(([key]) => key !== 'sessionId')), requestScope(request, true), request.signal); }],
    ['/api/dsh-e2e/log-library/info', ['GET'], request => service.logLibrary.info(new URL(request.url).searchParams.get('id'), requestScope(request, true))],
    ['/api/dsh-e2e/log-library/select', ['POST'], async request => service.logLibrary.select(await mutationBody(request), requestScope(request, true))],
    ['/api/dsh-e2e/log-library/unassigned', ['GET'], request => service.logLibrary.unassigned(requestScope(request, true))],
    ['/api/dsh-e2e/log-library/trash', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.trash(p.get('offset') || 0, p.get('limit') || 20, requestScope(request, true)); }],
    ['/api/dsh-e2e/log-library/clear-analysis-cache', ['POST'], async request => { await mutationBody(request); return service.logLibrary.clearAnalysisCache(requestScope(request, true)); }],
    ['/api/dsh-e2e/log-library/usage', ['GET'], request => service.logLibrary.usage(requestScope(request, true))],
    ['/api/dsh-e2e/log-library/purge', ['POST'], async request => { const body = await mutationBody(request); if (body.confirm !== true) throw Error('请明确确认永久清空当前会话的回收区'); return service.logLibrary.purge(requestScope(request, true), body.before); }],
    ['/api/dsh-e2e/log-library/rename', ['POST'], async request => { const body = await mutationBody(request); return service.logLibrary.rename(body.id, body.name, requestScope(request, true)); }],
    ['/api/dsh-e2e/log-library/assign', ['POST'], async request => service.logLibrary.assign((await mutationBody(request)).id, requestScope(request, true))],
    ['/api/dsh-e2e/log-library/delete', ['POST'], async request => service.logLibrary.remove(await mutationBody(request, 512 * 1024), requestScope(request, true))],
    ['/api/dsh-e2e/log-library/delete-permanently', ['POST'], async request => service.logLibrary.remove(await mutationBody(request, 512 * 1024), requestScope(request, true))],
    ['/api/dsh-e2e/log-library/restore', ['POST'], async request => { const body = await mutationBody(request); return service.logLibrary.restore(body.batchId, requestScope(request, true), body.ids); }],
    ['/api/dsh-e2e/log-library/begin', ['POST'], async request => service.logLibrary.begin(await mutationBody(request), requestScope(request, true))],
    ['/api/dsh-e2e/log-library/chunk', ['POST'], async request => { const scope = requestScope(request, true); assertMutationOrigin(request); const p = new URL(request.url).searchParams; const length = Number(request.headers.get('content-length')); if (length > 262144) throw Error('日志分块过大'); const data = Buffer.from(await request.arrayBuffer()); return service.logLibrary.chunk(p.get('id'), Number(p.get('index')), data, scope); }],
    ['/api/dsh-e2e/log-library/finish', ['POST'], async request => service.logLibrary.finish((await mutationBody(request)).id, requestScope(request, true))],
    ['/api/dsh-e2e/log-library/abort', ['POST'], async request => service.logLibrary.abort((await mutationBody(request)).id, requestScope(request, true))],
    ['/api/dsh-e2e/log-library/logs', ['GET'], request => { const p = new URL(request.url).searchParams; return service.logLibrary.getLogs(p.get('id'), Object.fromEntries([...p].filter(([key]) => key !== 'id')), requestScope(request, true), request.signal); }],
    ['/api/dsh-e2e/status', ['GET'], request => service.status(requestScope(request))],

    // validation-v1: task / attempt / events / evidence.
    ['/api/dsh-e2e/validation/tasks', ['GET'], request => service.validation.readValidation(requestScope(request).sessionId, {})],
    ['/api/dsh-e2e/validation/task', ['GET'], request => { const p = new URL(request.url).searchParams; return service.validation.readValidation(requestScope(request).sessionId, { taskId: p.get('taskId'), includeLegacy: p.get('includeLegacy') === 'true' }); }],
    ['/api/dsh-e2e/validation/attempt', ['GET'], request => { const p = new URL(request.url).searchParams; return service.validation.readValidation(requestScope(request).sessionId, { taskId: p.get('taskId'), attemptId: p.get('attemptId'), afterSeq: Number(p.get('afterSeq') || 0), limit: Math.min(Number(p.get('limit') || 100), 500) }); }],
    ['/api/dsh-e2e/validation/events', ['GET'], request => { const p = new URL(request.url).searchParams; return service.validation.readValidation(requestScope(request).sessionId, { taskId: p.get('taskId'), attemptId: p.get('attemptId'), afterSeq: Number(p.get('afterSeq') || 0), limit: Math.min(Number(p.get('limit') || 100), 500) }); }],
    ['/api/dsh-e2e/capture/stop', ['POST'], async request => service.validation.stopCapture(requestScope(request, true).sessionId, await mutationBody(request))],
    ['/api/dsh-e2e/validation/cancel', ['POST'], async request => service.validation.cancelValidation(requestScope(request, true).sessionId, await mutationBody(request))],
    ['/api/dsh-e2e/validation/attach-capture', ['POST'], async request => service.validation.attachCapture(requestScope(request, true).sessionId, await mutationBody(request))],

    // Read-only legacy history (the same list the existing UI renders).
    ['/api/dsh-e2e/runs', ['GET'], request => { const p = new URL(request.url).searchParams; return service.listPage({ ...requestScope(request), offset: p.get('offset') || 0, limit: p.get('limit') || 20, query: p.get('query') || '', status: p.get('status') || undefined, archived: p.get('archived') === 'true' }); }],
    ['/api/dsh-e2e/report', ['GET'], request => service.report(new URL(request.url).searchParams.get('id'), requestScope(request))],
    ['/api/dsh-e2e/logs', ['GET'], request => { const p = new URL(request.url).searchParams; return service.getLogs(p.get('id'), { offset: p.get('offset') || 0, limit: p.get('limit') || 100, level: p.get('level') || undefined, query: p.get('query') || '', tag: p.get('tag') || '', domain: p.get('domain') || '', pid: p.get('pid') || '', tid: p.get('tid') || '', regex: p.get('regex') === 'true', caseSensitive: p.get('caseSensitive') === 'true', fullMessage: p.get('fullMessage') === 'true', from: p.get('from'), until: p.get('until') }, requestScope(request)); }],

    // Retired write endpoints answer with a migration error, never by executing.
    ['/api/dsh-e2e/cancel', ['POST'], async request => { await mutationBody(request); throw retired('cancel'); }],
    ['/api/dsh-e2e/archive', ['POST'], async request => { await mutationBody(request); throw retired('archive'); }],
  ]) ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', async fetch(request) { try { return Response.json(await handler(request), { headers: { 'cache-control': 'no-store' } }); } catch (error) { return Response.json({ error: error.message, code: error.code, retired: error.code === 'OPERATION_RETIRED' }, { status: 400 }); } } }), `dshE2E: ${path}`);

  for (const path of ['/api/dsh-e2e/log-export', '/api/dsh-e2e/log-library/export']) ctx.effect(() => ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try {
      const p = new URL(request.url).searchParams, options = Object.fromEntries(p), id = p.get('id');
      if (path.includes('log-library')) {
        const source = await service.logLibrary.export(id, options, requestScope(request, true));
        return new Response(Readable.toWeb(byteStream(source)), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="filtered-logs.jsonl"', 'x-content-type-options': 'nosniff' } });
      }
      const scope = requestScope(request);
      if (id.includes('/')) {
        const [taskId, attemptId] = id.split('/');
        await service.ensureCaptureExportable(scope, { ...options, taskId, attemptId });
        const source = service.captureExport(scope, { ...options, taskId, attemptId });
        return new Response(Readable.toWeb(byteStream(source)), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="filtered-logs.jsonl"', 'x-content-type-options': 'nosniff' } });
      }
      const job = await service.get(id, scope);
      const source = await exportLogStream(job, options);
      return new Response(Readable.toWeb(byteStream(source)), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="filtered-logs.jsonl"', 'x-content-type-options': 'nosniff' } });
    }
    catch (error) { return Response.json({ error: error.message, code: error.code }, { status: (error.code === 'CAPTURE_EXPORT_NOT_FOUND' || /找不到该任务/.test(error.message)) ? 404 : 400 }); }
  } }), 'dshE2E: filtered log export ' + path);

  // Web Response streams must receive bytes, not strings, when a generator is
  // bridged with Readable.toWeb.
  const byteStream = source => Readable.from((async function* () {
    for await (const chunk of source) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
  })());

  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-e2e/validation/capture-file', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try {
      const p = new URL(request.url).searchParams, scope = requestScope(request);
      const value = await service.captureFilePath(scope, { captureId: p.get('captureId'), taskId: p.get('taskId') || undefined, attemptId: p.get('attemptId') || undefined });
      const info = await stat(value.path).catch(() => undefined);
      if (!info?.isFile()) throw new Error('找不到该采集的日志文件');
      return new Response(Readable.toWeb(createReadStream(value.path)), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch (error) { return Response.json({ error: error.message }, { status: 404 }); }
  } }), 'dshE2E: capture log file');

  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-e2e/log-library/source', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try { const value = await service.logLibrary.source(new URL(request.url).searchParams.get('id'), requestScope(request, true)); const source = createReadStream(value.path); return new Response(Readable.toWeb(value.compressed ? source.pipe(createGunzip()) : source), { headers: { 'content-type': /\.(zip|gz|rar)$/i.test(value.name) ? 'application/octet-stream' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(value.name), 'x-content-type-options': 'nosniff' } }); }
    catch (error) { return Response.json({ error: error.message }, { status: 404 }); }
  } }), 'dshE2E: original log');

  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-e2e/artifact', methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    try {
      const p = new URL(request.url).searchParams, id = p.get('id'), file = p.get('file') || 'e2e/summary.md', scope = requestScope(request);
      if (typeof id === 'string' && id.includes('/')) {
        // validation-v1 evidence: only files actually inside that attempt.
        const [taskId, attemptId] = id.split('/');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(file)) throw new Error('文件类型不允许');
        const path = await service.evidenceFileFor(scope, taskId, attemptId, file);
        const info = await stat(path);
        if (info.size > 16 * 1024 * 1024) throw new Error('文件过大，请在本机证据目录查看');
        return new Response(await readFile(path), { headers: { 'content-type': /\.png$/i.test(file) ? 'image/png' : /\.json$/i.test(file) ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
      }
      const root = await service.legacy.fileRoot(id, scope);
      if (!/\.(md|json|jsonl|png|xml|log|txt)$/i.test(file)) throw new Error('文件类型不允许');
      const realRoot = await realpath(root), path = await realpath(inside(realRoot, file));
      inside(realRoot, path);
      if (file === 'app-logs.jsonl') { if ((await stat(path)).size > 128 * 1024 * 1024) throw Error('日志文件超过下载上限'); return new Response(Readable.toWeb(createReadStream(path)), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } }); }
      if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('文件过大，请在本机报告目录查看');
      return new Response(await readFile(path), { headers: { 'content-type': file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch (error) { return Response.json({ error: error.message }, { status: 404 }); }
  } }), 'dshE2E: artifacts');
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
