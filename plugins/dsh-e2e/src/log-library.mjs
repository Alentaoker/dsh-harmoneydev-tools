import { mkdir, writeFile, appendFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
  const base = join(root, 'log-library'), uploads = new Map();
  const directory = id => { if (!idPattern.test(id || '')) throw Error('日志文件 ID 无效'); return join(base, id); };
  async function metadata(id) { return JSON.parse(await readFile(join(directory(id), 'library.json'), 'utf8')); }
  return {
    async list(offset = 0, limit = 20) {
      offset = Number(offset); limit = Number(limit);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('日志库分页参数无效');
      const ids = (await readdir(base).catch(() => [])).filter(id => idPattern.test(id));
      const values = [];
      for (const id of ids) { try { const value = await metadata(id); if (value.status === 'ready') values.push(value); } catch {} }
      values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { files: values.slice(offset, offset + limit), total: values.length, offset, nextOffset: offset + limit < values.length ? offset + limit : null };
    },
    async begin({ name, size }) {
      if (typeof name !== 'string' || !name.trim() || name.length > 256 || !Number.isSafeInteger(size) || size < 1 || size > DEFAULT_LOG_BYTES) throw Error('仅支持 1 字节～32 MiB 的 UTF-8 TXT/LOG/JSONL 文件');
      if (uploads.size >= 2) throw Error('已有日志导入正在进行，请等待完成');
      const id = randomUUID(), dir = directory(id); await mkdir(dir, { recursive: true });
      const value = { id, name: name.split(/[\\/]/).pop(), size, received: 0, nextChunk: 0, createdAt: new Date().toISOString(), status: 'importing' };
      await writeFile(join(dir, 'source.log'), ''); await writeFile(join(dir, 'library.json'), JSON.stringify(value)); uploads.set(id, value);
      return value;
    },
    async chunk(id, index, data) {
      const value = uploads.get(id); if (!value || value.busy) throw Error('日志导入不存在或正在写入');
      if (!Number.isSafeInteger(index) || index !== value.nextChunk || !data.length || data.length > 256 * 1024 || value.received + data.length > value.size) throw Error('日志分块大小或顺序无效');
      value.busy = true;
      try { await appendFile(join(directory(id), 'source.log'), data); value.received += data.length; value.nextChunk++; return { received: value.received, size: value.size }; }
      finally { value.busy = false; }
    },
    async finish(id) {
      const value = uploads.get(id); if (!value || value.busy || value.received !== value.size) throw Error('日志文件尚未完整上传');
      value.busy = true; const dir = directory(id); let parsed = 0, unparsed = 0, truncatedLines = 0, normalizedBytes = 0, dropped = 0, output = '';
      const input = createReadStream(join(dir, 'source.log'), { highWaterMark: 16384 });
      await writeFile(join(dir, 'app-logs.jsonl'), '');
      try {
        for await (const { line: source, truncated } of boundedLogLines(input, 8192, true)) {
          if (!source.trim()) continue;
          if (truncated) truncatedLines++;
          const entry = parseImportedLog(source.slice(0, 8192));
          const line = JSON.stringify(entry) + '\n', bytes = Buffer.byteLength(line);
          if (normalizedBytes + bytes > 64 * 1024 * 1024) { dropped++; continue; }
          normalizedBytes += bytes; if (entry.parsed) parsed++; else unparsed++;
          output += line; if (output.length > 65536) { await appendFile(join(dir, 'app-logs.jsonl'), output); output = ''; }
        }
        if (output) await appendFile(join(dir, 'app-logs.jsonl'), output);
        const completed = { ...value, busy: undefined, status: 'ready', parsed, unparsed, truncatedLines, dropped, count: parsed + unparsed, normalizedBytes, format: parsed ? 'HiLog / JSONL 自动识别' : '原文行', timeBasis: '日志中的设备时间；缺年份按最近年份推定，未解析行不参与时间过滤' };
        await writeFile(join(dir, 'library.json'), JSON.stringify(completed)); uploads.delete(id); return completed;
      } catch (error) { value.busy = false; throw error; }
      finally { input.destroy(); }
    },
    async abort(id) { const value = uploads.get(id); if (!value || value.busy) throw Error('不能取消正在写入的日志'); uploads.delete(id); await rm(directory(id), { recursive: true, force: true }); return { removed: true }; },
    async getLogs(id, options) {
      const value = await metadata(id); if (value.status !== 'ready') throw Error('日志导入尚未完成');
      const warnings = [`原始文件保留在本机；查看器中的敏感字段脱敏，单行最多 8192 字符。${value.timeBasis}`];
      if (value.truncatedLines) warnings.push(`${value.truncatedLines} 条超长行仅在原始文件完整保留`);
      if (value.dropped) warnings.push(`${value.dropped} 条超过 64 MiB 结构化日志容量，原始文件仍完整保留`);
      return archivedLogPage({ id, directory: directory(id), logCollection: { status: 'captured', warnings, persisted: value.count } }, options);
    },
    async export(id, options) { const value = await metadata(id); if (value.status !== 'ready') throw Error('日志导入尚未完成'); return exportLogStream({ directory: directory(id) }, options); },
    async source(id) { const value = await metadata(id); if (value.status !== 'ready') throw Error('日志导入尚未完成'); const path = join(directory(id), 'source.log'); if ((await stat(path)).size > DEFAULT_LOG_BYTES) throw Error('原始日志文件超过下载上限'); return { path, name: value.name }; },
  };
}
