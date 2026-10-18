// Read-only adapter for legacy dshE2E layouts (`workflows/<flow>/runs/<id>`).
//
// It never calls records.ready(): that function rewrites record.json, promotes
// queued/running to interrupted and normalises fields on disk. Legacy data is
// evidence of what the old runner did; this module only reads it and marks what
// the old format never recorded instead of inventing sent/confirmed/complete.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const LEGACY_FORMAT = 'legacy-e2e-v1';
const flowPattern = /^[a-f0-9]{24}$/;
const idPattern = /^[a-f0-9-]{36}$/;

export function legacyScopeFailure(record, scope) {
  if (scope?.all === true) return null;
  if (!scope?.sessionId) return '请在一个会话中打开 dshE2E 历史';
  if (!record.sessionId || record.sessionId !== scope.sessionId) return '此历史记录不属于当前会话';
  return null;
}

/** A legacy row as displayed. Nothing here is a device fact. */
export function legacyRunView(record, { active = false } = {}) {
  const unfinished = ['queued', 'running'].includes(record.status);
  return {
    ...record,
    format: LEGACY_FORMAT,
    // Display-only explanation; the file on disk keeps its original status.
    displayStatus: unfinished ? 'interrupted' : record.status,
    status: unfinished ? 'interrupted' : record.status,
    legacyNote: unfinished
      ? '历史记录未正常结束：宿主中断或旧运行器未收尾。原文件保留原状态，只读展示。'
      : '旧格式记录：没有派发状态、坐标、日志完整性和清理结果，均按“旧格式未记录”展示。',
    legacy: {
      readOnly: true,
      originalStatus: record.status,
      dispatchState: 'unknown',
      effect: 'unknown',
      verification: record.status === 'passed' ? 'recorded-by-legacy-runner' : 'unknown',
      logIntegrity: record.logCollection ? 'legacy-derived' : 'not-recorded',
      cleanup: 'not-recorded',
      active,
    },
  };
}

export function createLegacyReader(root) {
  const runsRoot = join(root, 'workflows');
  const directories = new Map(); let cache;

  async function scan() {
    const records = new Map();
    for (const flow of await readdir(runsRoot).catch(() => [])) {
      if (!flowPattern.test(flow)) continue;
      for (const id of await readdir(join(runsRoot, flow, 'runs')).catch(() => [])) {
        if (!idPattern.test(id)) continue;
        const directory = join(runsRoot, flow, 'runs', id);
        try {
          let value;
          try { value = JSON.parse(await readFile(join(directory, 'record.json'), 'utf8')); }
          catch { value = JSON.parse(await readFile(join(directory, 'dsh-run.json'), 'utf8')); }
          if (value.id !== id || value.flowId !== flow) continue;
          try {
            const logs = JSON.parse(await readFile(join(directory, 'app-logs.meta.json'), 'utf8'));
            value = { ...value, logCollection: logs, logCount: logs.persisted ?? value.logCount };
          } catch { /* 旧报告可以没有日志元数据 */ }
          directories.set(id, directory);
          records.set(id, value);
        } catch { /* 单条破损旧记录不能遮挡其他历史 */ }
      }
    }
    return records;
  }

  async function all() { if (!cache) cache = await scan(); return [...cache.values()]; }

  return {
    format: LEGACY_FORMAT,
    readOnly: true,
    async list(scope) {
      const rows = (await all()).filter(record => !legacyScopeFailure(record, scope));
      return rows.map(record => legacyRunView(record)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
    async get(id, scope) {
      if (!idPattern.test(id || '')) throw new Error('报告 ID 无效');
      const record = (await all()).find(value => value.id === id);
      if (!record) throw new Error('找不到此历史报告（只读历史适配器）');
      const failure = legacyScopeFailure(record, scope);
      if (failure) throw new Error(failure);
      const directory = directories.get(id);
      let saved;
      try { saved = JSON.parse(await readFile(join(directory, 'dsh-run.json'), 'utf8')); }
      catch { saved = record; }
      return { ...saved, ...record, format: LEGACY_FORMAT, directory, readOnly: true };
    },
    async report(id, scope) {
      const job = await this.get(id, scope);
      let report; try { report = JSON.parse(await readFile(join(job.directory, 'e2e/report.json'), 'utf8')); } catch { report = undefined; }
      return { run: legacyRunView(job), report, reportWritten: !!report, readOnly: true, format: LEGACY_FORMAT };
    },
    async logCollectionFile(id, scope) {
      const job = await this.get(id, scope);
      const file = join(job.directory, 'app-logs.jsonl');
      const info = await stat(file).catch(() => undefined);
      return info?.isFile() ? { path: file, size: info.size } : undefined;
    },
    async fileRoot(id, scope) {
      const job = await this.get(id, scope);
      return job.directory;
    },
    async invalidate() { cache = undefined; },
  };
}
