import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const activeStatuses = ['queued', 'running'];
export function assertScope(record, scope) {
  if (scope && scope.all !== true && (!scope.sessionId || record.sessionId !== scope.sessionId)) throw new Error('此记录不属于当前会话');
}
export function paginate(records, options = {}) {
  const offset = Number(options.offset ?? 0), limit = Number(options.limit ?? 20);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('记录分页参数无效');
  const { status, query = '', archived = false } = options;
  if (status && !['active', 'passed', 'failed', 'cancelled', 'interrupted'].includes(status)) throw new Error('记录分类无效');
  const scoped = records.filter(r => (options.all === true || !!options.sessionId && r.sessionId === options.sessionId) && !!r.archived === archived);
  const counts = { all: scoped.length, active: 0, passed: 0, failed: 0, cancelled: 0, interrupted: 0 };
  for (const r of scoped) counts[activeStatuses.includes(r.status) ? 'active' : r.status] = (counts[activeStatuses.includes(r.status) ? 'active' : r.status] || 0) + 1;
  const needle = String(query).slice(0, 256).toLocaleLowerCase();
  const filtered = scoped.filter(r => (!status || (status === 'active' ? activeStatuses.includes(r.status) : r.status === status)) && (!needle || `${r.name} ${r.error || ''} ${r.device || ''}`.toLocaleLowerCase().includes(needle))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { runs: filtered.slice(offset, offset + limit), total: scoped.length, filteredTotal: filtered.length, counts, offset, limit, nextOffset: offset + limit < filtered.length ? offset + limit : null };
}
export function createRecordStore(root) {
  const index = new Map(); let initialization;
  const directory = record => join(root, 'workflows', record.flowId, 'runs', record.id);
  async function atomic(path, value) { await writeFile(path + '.tmp', JSON.stringify(value, null, 2)); await rename(path + '.tmp', path); }
  const compact = ({ args, logs, report, ...record }) => record;
  async function ready() {
    if (!initialization) initialization = (async () => {
      for (const flow of await readdir(join(root, 'workflows')).catch(() => [])) {
        if (!/^[a-f0-9]{24}$/.test(flow)) continue;
        for (const id of await readdir(join(root, 'workflows', flow, 'runs')).catch(() => [])) {
          if (!/^[a-f0-9-]{36}$/.test(id)) continue;
          const dir = join(root, 'workflows', flow, 'runs', id);
          try {
            let value;
            try { value = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8')); }
            catch { value = compact(JSON.parse(await readFile(join(dir, 'dsh-run.json'), 'utf8'))); }
            if (value.id !== id || value.flowId !== flow) continue;
            try { const logs = JSON.parse(await readFile(join(dir, 'app-logs.meta.json'), 'utf8')); value = { ...value, logCollection: logs, logCount: logs.persisted }; } catch {}
            if (activeStatuses.includes(value.status)) value = { ...value, status: 'interrupted', error: '宿主重启中断了这次测试，请检查设备后创建复测。', checks: { ...value.checks, leaseReleased: false } };
            await atomic(join(dir, 'record.json'), value);
            index.set(id, value);
          } catch { /* One damaged record must not hide other reports. */ }
        }
      }
    })();
    await initialization;
  }
  return {
    directory, ready,
    async save(record, full) { await ready(); const dir = directory(record); await mkdir(dir, { recursive: true }); if (full) await atomic(join(dir, 'dsh-run.json'), full); await atomic(join(dir, 'record.json'), compact(record)); index.set(record.id, compact(record)); },
    async all() { await ready(); return [...index.values()]; },
    async get(id, scope) { await ready(); if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('报告 ID 无效'); const record = index.get(id); if (!record) throw new Error('找不到此报告'); assertScope(record, scope); const saved = JSON.parse(await readFile(join(directory(record), 'dsh-run.json'), 'utf8')); return { ...saved, ...record, directory: directory(record) }; },
  };
}
