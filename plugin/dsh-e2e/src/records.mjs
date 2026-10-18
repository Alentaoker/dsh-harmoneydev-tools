// Legacy record helpers, kept read-only.
//
// The old `createRecordStore().ready()` rewrote record.json on every startup and
// promoted queued/running rows to interrupted. That side effect is gone: the
// read-only adapter in legacy.mjs is the only way to read legacy data now.
export const activeStatuses = ['queued', 'running'];

export function assertScope(record, scope) {
  if (scope?.all === true) return record;
  if (!scope?.sessionId || record.sessionId !== scope.sessionId) throw new Error('此记录不属于当前会话');
  return record;
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
