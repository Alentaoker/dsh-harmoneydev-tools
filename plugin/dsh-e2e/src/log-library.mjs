import { mkdir, writeFile, appendFile, readFile, readdir, rm, stat, rename, cp, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { normalizeLog } from './log-query.mjs';
import { archivedLogPage, DEFAULT_LOG_BYTES, boundedLogLines, exportLogStream } from './log-archive.mjs';
import { redactLog } from './logs.mjs';

const idPattern = /^[0-9a-f-]{36}$/;
const levels = { D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal' };
export function parseImportedLog(line, now = new Date()) {
  line = String(line).replace(/^\uFEFF/, '');
  try {
    const value = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const message = typeof value.message === 'string' ? value.message : typeof value.msg === 'string' ? value.msg : line;
      return { ...normalizeLog({ ...value, level: levels[value.level] || value.level || 'unknown', message: redactLog(message), raw: redactLog(line) }), imported: true, parsed: true };
    }
  } catch {}
  // HiLog standard text: timestamp PID TID L DOMAIN TAG: message, and the
  // DevEco exported layout timestamp PID-TID DOMAIN/process/TAG L message.
  const standard = line.match(/^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([DIWEF])\s+([A-Z]?[0-9A-Fa-f]{4,8})\s+([^:]+):\s?(.*)$/);
  const exported = line.match(/^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)[-\s]+(\d+)\s+([A-Z]?[0-9A-Fa-f]{4,8}\/\S+)\s+([DIWEF])\s+(.*)$/);
  const hdc = line.match(/^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\d+)\s+([DIWEF])\s+([A-Z]?[0-9A-Fa-f]{4,8}\/[^\s:]+):\s?(.*)$/);
  let value;
  if (standard) { const [, timestamp, pid, tid, level, domain, tag, message] = standard; value = { timestamp, pid: +pid, tid: +tid, level: levels[level], domain, tag, message }; }
  else if (exported) { const [, timestamp, pid, tid, tag, level, message] = exported; value = normalizeLog({ timestamp, pid: +pid, tid: +tid, tag, level: levels[level], message }); }
  else if (hdc) { const [, timestamp, pid, tid, level, tag, message] = hdc; value = normalizeLog({ timestamp, pid: +pid, tid: +tid, tag, level: levels[level], message }); }
  if (value) {
    const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
    const parts = value.timestamp.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d+)$/);
    const dates = years.map(year => new Date(year, +parts[1] - 1, +parts[2], +parts[3], +parts[4], +parts[5], +(parts[6] + '000').slice(0, 3))).sort((a, b) => Math.abs(a - now) - Math.abs(b - now));
    return { ...value, capturedAt: dates[0].toISOString(), message: redactLog(value.message), raw: redactLog(line), imported: true, parsed: true };
  }
  return { level: 'unknown', tag: '', message: redactLog(line), raw: redactLog(line), imported: true, parsed: false };
}

export function createLogLibrary(root) {
  const base = resolve(root, 'log-library'), uploads = new Map(), locks = new Map(), selections = new Map();
  const owner = scope => {
    const id = scope?.sessionId;
    if (typeof id !== 'string' || !id || id.length > 256) throw Error('请在一个会话中打开日志工作台');
    return id;
  };
  const key = scope => createHash('sha256').update(owner(scope)).digest('hex');
  const sessionDirectory = scope => join(base, 'sessions', key(scope));
  const validId = id => { if (!idPattern.test(id || '')) throw Error('日志文件 ID 无效'); return id; };
  const directory = (id, scope) => join(sessionDirectory(scope), validId(id));
  async function checked(path) {
    const resolved = await realpath(path), parent = await realpath(base), rel = relative(parent, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('日志路径超出暂存目录');
    return resolved;
  }
  async function metadata(id, scope) {
    const dir = await checked(directory(id, scope)).catch(error => { if (error.code === 'ENOENT') throw Error('当前会话没有这份日志，或文件已删除'); throw error; });
    const value = JSON.parse(await readFile(await checked(join(dir, 'library.json')), 'utf8'));
    if (value.sessionId !== owner(scope) || value.id !== id) throw Error('日志不属于当前会话');
    if (value.status !== 'ready') throw Error('日志导入尚未完成');
    return value;
  }
  const uploadFor = (id, scope) => { validId(id); const value = uploads.get(id); if (!value || value.sessionId !== owner(scope)) throw Error('当前会话没有这个日志导入'); return value; };
  async function cleanupCancelled(value) { if (value.cancelled && !value.busy) { await rm(await checked(directory(value.id, { sessionId: value.sessionId })), { recursive: true, force: true }); uploads.delete(value.id); } }
  async function locked(scope, fn) {
    const token = key(scope), previous = locks.get(token) || Promise.resolve();
    const task = previous.catch(() => {}).then(fn); locks.set(token, task);
    try { return await task; } finally { if (locks.get(token) === task) locks.delete(token); }
  }
  async function files(scope, options = {}) {
    const query = String(options.query || '').trim().toLocaleLowerCase();
    if (query.length > 256) throw Error('文件搜索最多 256 字符');
    if (options.before && !Number.isFinite(Date.parse(options.before))) throw Error('文件选择时间无效');
    if (options.sourceKind && !['import', 'realtime', 'legacy'].includes(options.sourceKind)) throw Error('日志来源筛选无效');
    const ids = (await readdir(sessionDirectory(scope)).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(id => idPattern.test(id));
    const values = [];
    for (const id of ids) {
      try { const value = await metadata(id, scope); if ((!query || value.name.toLocaleLowerCase().includes(query)) && (!options.sourceKind || value.sourceKind === options.sourceKind) && (!options.before || (value.availableAt || value.createdAt) <= options.before)) values.push(value); } catch {}
    }
    if (options.sort && !['newest', 'oldest', 'name', 'size'].includes(options.sort)) throw Error('日志排序参数无效');
    return values.sort((a, b) => (options.sort === 'name' ? a.name.localeCompare(b.name) : options.sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : options.sort === 'size' ? b.size - a.size : b.createdAt.localeCompare(a.createdAt)) || a.id.localeCompare(b.id));
  }
  async function trashed(scope) {
    const parent = join(base, 'trash', key(scope)), values = [];
    for (const batchId of (await readdir(parent).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(id => idPattern.test(id))) {
      const dir = await checked(join(parent, batchId)), deletedAt = (await stat(dir)).birthtime.toISOString();
      for (const id of (await readdir(dir)).filter(id => idPattern.test(id))) {
        try { const path = await checked(join(dir, id)), value = JSON.parse(await readFile(await checked(join(path, 'library.json')), 'utf8')); if (value.sessionId === owner(scope) && value.id === id) values.push({ ...value, batchId, deletedAt }); } catch {}
      }
    }
    return values.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.id.localeCompare(b.id));
  }
  const library = {
    async list(offset = 0, limit = 20, scope, options = {}) {
      owner(scope); offset = Number(offset); limit = Number(limit);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('日志库分页参数无效');
      const snapshotBefore = new Date().toISOString(), values = await files(scope, { ...options, before: options.before || snapshotBefore });
      return { protocolVersion: 2, files: values.slice(offset, offset + limit), total: values.length, offset, snapshotBefore, nextOffset: offset + limit < values.length ? offset + limit : null, sessionId: owner(scope) };
    },
    async begin({ name, size, sourceKind = 'import', snapshot }, scope) {
      const sessionId = owner(scope);
      if (typeof name !== 'string' || !name.trim() || name.length > 256 || !Number.isSafeInteger(size) || size < 1 || size > DEFAULT_LOG_BYTES) throw Error('仅支持 1 字节～32 MiB 的 UTF-8 TXT/LOG/JSONL 文件');
      if (!['import', 'realtime'].includes(sourceKind)) throw Error('日志来源无效');
      if (snapshot !== undefined && (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || JSON.stringify(snapshot).length > 3000)) throw Error('日志快照信息无效');
      // Reserve synchronously: simultaneous begin requests must share this cap.
      if (uploads.size >= 2) throw Error('已有日志导入正在进行，请等待完成');
      const id = randomUUID(), dir = directory(id, scope);
      const value = { id, sessionId, name: name.split(/[\\/]/).pop(), sourceKind, snapshot, size, received: 0, nextChunk: 0, createdAt: new Date().toISOString(), status: 'importing', busy: true };
      uploads.set(id, value);
      try { await mkdir(dir, { recursive: true }); await checked(dir); await writeFile(join(dir, 'source.log'), ''); await writeFile(join(dir, 'library.json'), JSON.stringify({ ...value, busy: undefined })); value.busy = false; return { ...value, busy: undefined }; }
      catch (error) { uploads.delete(id); throw error; }
    },
    async chunk(id, index, data, scope) {
      const value = uploadFor(id, scope); if (value.busy) throw Error('日志正在写入');
      if (!Number.isSafeInteger(index) || index !== value.nextChunk || !data.length || data.length > 256 * 1024 || value.received + data.length > value.size) throw Error('日志分块大小或顺序无效');
      value.busy = true;
      try { await appendFile(await checked(join(directory(id, scope), 'source.log')), data); value.received += data.length; value.nextChunk++; return { received: value.received, size: value.size }; }
      finally { value.busy = false; await cleanupCancelled(value); }
    },
    async finish(id, scope) {
      const value = uploadFor(id, scope); if (value.busy || value.received !== value.size) throw Error('日志文件尚未完整上传');
      value.busy = true; const dir = await checked(directory(id, scope));
      let parsed = 0, unparsed = 0, truncatedLines = 0, normalizedBytes = 0, dropped = 0, sourceLine = 0, output = '', firstTimestamp, lastTimestamp;
      const input = createReadStream(await checked(join(dir, 'source.log')), { highWaterMark: 16384 }), hash = createHash('sha256');
      async function* hashed() { for await (const chunk of input) { hash.update(chunk); yield chunk; } }
      try {
        await writeFile(join(dir, 'app-logs.jsonl'), '');
        for await (const { line: source, truncated } of boundedLogLines(hashed(), 8192, true)) {
          if (value.cancelled) throw Error('导入已取消');
          sourceLine++; if (!source.trim()) continue;
          if (truncated) truncatedLines++;
          const entry = { ...parseImportedLog(source), sourceLine };
          const line = JSON.stringify(entry) + '\n', bytes = Buffer.byteLength(line);
          if (normalizedBytes + bytes > 64 * 1024 * 1024) { dropped++; continue; }
          if (entry.timestamp) { firstTimestamp ||= entry.timestamp; lastTimestamp = entry.timestamp; }
          normalizedBytes += bytes; if (entry.parsed) parsed++; else unparsed++;
          output += line; if (output.length > 65536) { await appendFile(join(dir, 'app-logs.jsonl'), output); output = ''; }
        }
        if (output) await appendFile(join(dir, 'app-logs.jsonl'), output);
        if (value.cancelled) throw Error('导入已取消');
        const completed = { ...value, busy: undefined, cancelled: undefined, status: 'ready', availableAt: new Date().toISOString(), parsed, unparsed, truncatedLines, dropped, count: parsed + unparsed, normalizedBytes, firstTimestamp, lastTimestamp, sha256: hash.digest('hex'), format: parsed ? 'HiLog / JSONL 自动识别' : '原文行', timeBasis: '日志中的设备时间；缺年份按最近年份推定，未解析行不参与时间过滤' };
        await writeFile(join(dir, 'library.json.tmp'), JSON.stringify(completed)); await rename(join(dir, 'library.json.tmp'), join(dir, 'library.json'));
        uploads.delete(id); return completed;
      } catch (error) { value.busy = false; throw error; }
      finally { input.destroy(); value.busy = false; await cleanupCancelled(value); }
    },
    async abort(id, scope) { const value = uploadFor(id, scope); value.cancelled = true; if (value.busy) return { pending: true }; await cleanupCancelled(value); return { removed: true }; },
    async info(id, scope) { return metadata(id, scope); },
    async select(options, scope) {
      const now = Date.now(); for (const [token, value] of selections) if (value.until < now) selections.delete(token);
      const ids = (await files(scope, options)).map(value => value.id); if (ids.length > 10000) throw Error('单次全选最多 10000 份日志，请按文件名或来源缩小范围');
      while (selections.size >= 10) selections.delete(selections.keys().next().value);
      const token = randomUUID(); selections.set(token, { sessionId: owner(scope), ids, until: now + 10 * 60000 });
      return { token, ids, count: ids.length };
    },
    async rename(id, name, scope) {
      return locked(scope, async () => {
        if (typeof name !== 'string' || !name.trim() || name.length > 256 || /[\\/\x00-\x1f]/.test(name)) throw Error('名称需为 1～256 字符，不能包含路径分隔符或控制字符');
        const value = { ...await metadata(id, scope), name: name.trim(), renamedAt: new Date().toISOString() }, dir = await checked(directory(id, scope));
        await writeFile(join(dir, 'library.json.tmp'), JSON.stringify(value)); await rename(join(dir, 'library.json.tmp'), join(dir, 'library.json')); return value;
      });
    },
    async trash(offset = 0, limit = 20, scope) {
      offset = Number(offset); limit = Number(limit); if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('回收区分页参数无效');
      const values = await trashed(scope); return { snapshotBefore: new Date().toISOString(), files: values.slice(offset, offset + limit), total: values.length, nextOffset: offset + limit < values.length ? offset + limit : null };
    },
    async usage(scope) { const ready = await files(scope), trash = await trashed(scope), bytes = values => values.reduce((sum, value) => sum + value.size + (value.normalizedBytes || 0), 0); return { files: ready.length, bytes: bytes(ready), trashFiles: trash.length, trashBytes: bytes(trash), instruction: '仅统计原始文件和结构化正文，不含元数据、导入临时文件及文件系统开销' }; },
    async getLogs(id, options, scope) {
      const value = await metadata(id, scope);
      const warnings = [`原始文件保留在本机；查看器中的敏感字段脱敏，单行最多 8192 字符。${value.timeBasis}`];
      if (value.truncatedLines) warnings.push(`${value.truncatedLines} 条超长行仅在原始文件完整保留`);
      if (value.dropped) warnings.push(`${value.dropped} 条超过 64 MiB 结构化日志容量，原始文件仍完整保留`);
      if (value.snapshot?.evicted || value.snapshot?.dropped) warnings.push(`实时连接累计：缓存淘汰 ${value.snapshot.evicted || 0} 条，接收省略 ${value.snapshot.dropped || 0} 条；不是此文件时间区间的精确缺失数量`);
      return archivedLogPage({ id, directory: await checked(directory(id, scope)), logCollection: { status: 'captured', warnings, persisted: value.count } }, options);
    },
    async export(id, options, scope) { await metadata(id, scope); await checked(join(directory(id, scope), 'app-logs.jsonl')); return exportLogStream({ directory: directory(id, scope) }, options); },
    async source(id, scope) { const value = await metadata(id, scope); const path = await checked(join(directory(id, scope), 'source.log')); if ((await stat(path)).size > DEFAULT_LOG_BYTES) throw Error('原始日志文件超过下载上限'); return { path, name: value.name }; },
    async remove({ ids, all = false, token, query = '', sourceKind = '', before, exclude = [] }, scope) {
      return locked(scope, async () => {
        const selection = token && selections.get(validId(token));
        if (token && (!selection || selection.sessionId !== owner(scope) || selection.until < Date.now())) throw Error('全选范围已过期或不属于当前会话，请重新选择');
        if (all && !before && !selection) throw Error('全选删除需要选择时的范围');
        if (!Array.isArray(ids ?? []) || !Array.isArray(exclude) || exclude.length > 10000) throw Error('日志选择参数无效');
        for (const id of exclude) validId(id);
        const excluded = new Set(exclude), targets = selection ? selection.ids.filter(id => !excluded.has(id)) : all ? (await files(scope, { query, sourceKind, before })).map(v => v.id).filter(id => !excluded.has(id)) : [...new Set(ids || [])];
        if (targets.length > 10000) throw Error('单次最多删除 10000 份日志');
        // Validate every requested owner before moving any file.
        for (const id of targets) await metadata(id, scope);
        const batchId = randomUUID(), trash = join(base, 'trash', key(scope), batchId);
        await mkdir(trash, { recursive: true }); await checked(trash);
        const removed = [], errors = [];
        for (const id of targets) { try { await rename(await checked(directory(id, scope)), join(trash, id)); removed.push(id); } catch (error) { errors.push({ id, error: error.message }); } }
        if (selection) selections.delete(token);
        return { batchId, removed: removed.length, errors };
      });
    },
    async restore(batchId, scope, ids) {
      return locked(scope, async () => {
        const trash = await checked(join(base, 'trash', key(scope), validId(batchId))), restored = [], errors = [];
        await mkdir(sessionDirectory(scope), { recursive: true });
        if (ids && (!Array.isArray(ids) || ids.length > 1000)) throw Error('恢复文件选择无效');
        const requested = ids ? new Set(ids.map(validId)) : undefined;
        for (const id of (await readdir(trash)).filter(id => idPattern.test(id) && (!requested || requested.has(id)))) {
          try { const source = await checked(join(trash, id)), value = JSON.parse(await readFile(await checked(join(source, 'library.json')), 'utf8')); if (value.sessionId !== owner(scope) || value.id !== id) throw Error('回收日志归属无效'); if (await stat(directory(id, scope)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw Error('同一 ID 已存在，不能覆盖'); await rename(source, directory(id, scope)); restored.push(id); } catch (error) { errors.push({ id, error: error.message }); }
        }
        return { restored: restored.length, errors };
      });
    },
    async purge(scope, before) {
      return locked(scope, async () => { if (!before || !Number.isFinite(Date.parse(before))) throw Error('回收区清空需要确认时的时间边界'); const values = (await trashed(scope)).filter(file => file.deletedAt <= before); const errors = []; let removed = 0; for (const file of values) { try { await rm(await checked(join(base, 'trash', key(scope), file.batchId, file.id)), { recursive: true, force: true }); removed++; } catch (error) { errors.push({ id: file.id, error: error.message }); } } return { removed, errors }; });
    },
    async unassigned(scope) {
      owner(scope); const values = [];
      for (const id of (await readdir(base).catch(() => [])).filter(id => idPattern.test(id))) {
        try { const value = JSON.parse(await readFile(await checked(join(base, id, 'library.json')), 'utf8')); if (value.status === 'ready' && !value.sessionId && !value.migratedTo) values.push({ id, name: value.name, size: value.size, count: value.count, createdAt: value.createdAt }); } catch {}
      }
      return { files: values.slice(0, 100), total: values.length };
    },
    async assign(id, scope) {
      return locked({ sessionId: 'legacy:' + validId(id) }, () => locked(scope, async () => {
        const source = await checked(join(base, validId(id))), value = JSON.parse(await readFile(await checked(join(source, 'library.json')), 'utf8'));
        if (value.sessionId || value.migratedTo || value.status !== 'ready') throw Error('这份旧日志已归属或不可迁移');
        if (uploads.size >= 2) throw Error('已有日志导入正在进行，请等待完成');
        const sourceSize = (await stat(await checked(join(source, 'source.log')))).size; if (sourceSize < 1 || sourceSize > DEFAULT_LOG_BYTES) throw Error('旧日志超过 32 MiB 或为空，原文件保留，请先分段');
        const newId = randomUUID(), dir = directory(newId, scope); await mkdir(sessionDirectory(scope), { recursive: true });
        async function digest(file) { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); }
        const hash = await digest(await checked(join(source, 'source.log')));
        await cp(source, dir, { recursive: true, dereference: false });
        if (hash !== await digest(await checked(join(dir, 'source.log')))) throw Error('旧日志复制校验失败，原文件保留');
        const pending = { ...value, id: newId, sessionId: owner(scope), sourceKind: 'legacy', migratedFrom: id, createdAt: new Date().toISOString(), status: 'importing', size: sourceSize, received: sourceSize, busy: false };
        uploads.set(newId, pending);
        const completed = await library.finish(newId, scope);
        await writeFile(join(source, 'library.json'), JSON.stringify({ ...value, migratedTo: { sessionId: owner(scope), id: newId, at: completed.createdAt, sha256: hash } }));
        return completed;
      }));
    },
    async dispose() { selections.clear(); for (const value of uploads.values()) { value.cancelled = true; if (!value.busy) await cleanupCancelled(value).catch(() => {}); } },
  };
  return library;
}
