// validation-v1 storage: task / attempt / append-only events / evidence.
//
// Single writer per attempt (events are serialised through a per-attempt
// promise chain), atomic metadata writes, and no rewriting of already committed
// event lines. A crashed tail (last line without newline) stays on disk and is
// reported as a gap instead of being repaired by guesswork.
import { appendFile, mkdir, open, lstat, readFile, readdir, rename, stat, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

export const VALIDATION_FORMAT = 'validation-v1';
export const TASK_SCHEMA = 1;
export const ATTEMPT_SCHEMA = 1;
export const EVENT_SCHEMA = 1;

const taskIdPattern = /^[a-z0-9][a-z0-9-]{7,63}$/;
const attemptIdPattern = /^[a-z0-9][a-z0-9-]{7,63}$/;
const evidenceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function newId(prefix) {
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** Session ids are host-trusted; never join raw strings into a path. */
export function sessionKey(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('需要活动会话');
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

export function assertTaskId(id) { if (!taskIdPattern.test(id || '')) throw new Error('taskId 无效'); return id; }
export function assertAttemptId(id) { if (!attemptIdPattern.test(id || '')) throw new Error('attemptId 无效'); return id; }

export function insideRoot(root, requested) {
  const destination = resolve(root, requested);
  const rel = relative(root, destination);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('文件路径超出验证目录');
  return destination;
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export function createValidationStore(root) {
  const base = join(root, 'validation-v1');
  const chains = new Map();
  const seqCache = new Map();

  const sessionDir = sessionId => join(base, 'sessions', sessionKey(sessionId));
  const taskDir = (sessionId, taskId) => join(sessionDir(sessionId), 'tasks', assertTaskId(taskId));
  const attemptDir = (sessionId, taskId, attemptId) => join(taskDir(sessionId, taskId), 'attempts', assertAttemptId(attemptId));

  /** Resolve an existing directory and prove it is still inside the validation root. */
  async function contained(directory) {
    const [real, rootReal] = await Promise.all([realpath(directory), realpath(base).catch(() => undefined)]);
    if (!rootReal) { await mkdir(base, { recursive: true }); return contained(directory); }
    const rel = relative(rootReal, real);
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('验证目录越界或被链接替换');
    return real;
  }

  async function readSafeJson(directory, file) {
    const real = await containedExisting(directory);
    const path = insideRoot(real, file);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isSymbolicLink()) throw new Error('验证文件不能是软链');
    return readJson(path);
  }

  async function ensure(directory) {
    await mkdir(directory, { recursive: true });
    return contained(directory);
  }

  /** Read-only containment: never creates directories while resolving a read. */
  async function containedExisting(directory) {
    try { return await contained(directory); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('找不到该验证目录'); throw error; }
  }

  function serialise(key, operation) {
    const previous = chains.get(key) || Promise.resolve();
    const next = previous.then(operation, operation);
    chains.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  async function listTasks(sessionId) {
    const directory = join(sessionDir(sessionId), 'tasks');
    const ids = await readdir(directory).catch(() => []);
    const tasks = [];
    for (const id of ids) {
      if (!taskIdPattern.test(id)) continue;
      const task = await readJson(join(directory, id, 'task.json')).catch(() => undefined);
      if (task?.taskId === id) tasks.push(task);
    }
    return tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  return {
    root: base,
    sessionDir,
    taskDir,
    attemptDir,
    contained,
    async listTasks(sessionId) { return listTasks(sessionId); },

    /** Read-only enumeration of every session key (for scope=all history). */
    async listSessionKeys() { return (await readdir(join(base, 'sessions')).catch(() => [])).filter(key => /^[a-f0-9]{32}$/.test(key)); },

    async listAllTasks() {
      const tasks = [];
      for (const key of await this.listSessionKeys()) {
        for (const id of await readdir(join(base, 'sessions', key, 'tasks')).catch(() => [])) {
          if (!taskIdPattern.test(id)) continue;
          const task = await readJson(join(base, 'sessions', key, 'tasks', id, 'task.json')).catch(() => undefined);
          if (task?.taskId === id) tasks.push(task);
        }
      }
      return tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    async readTask(sessionId, taskId) {
      const real = await containedExisting(taskDir(sessionId, taskId));
      const task = await readSafeJson(real, 'task.json');
      if (!task) throw new Error('找不到该任务');
      return task;
    },

    /**
     * Create or update a task under a revision guard. `expectedRevision` is the
     * revision the caller last saw; `undefined` means "must not exist yet".
     */
    async saveTask(sessionId, task) {
      assertTaskId(task.taskId);
      const directory = await ensure(taskDir(sessionId, task.taskId));
      return serialise(directory, async () => {
        const previous = await readJson(join(directory, 'task.json'));
        if (!previous && task.expectedRevision !== undefined) throw new Error('任务不存在，不能按已有 revision 更新');
        if (previous && previous.revision !== task.expectedRevision) {
          throw Object.assign(new Error(`任务已被更新到 revision ${previous.revision}，请重新读取后再保存`), { code: 'REVISION_CONFLICT' });
        }
        const now = new Date().toISOString();
        const value = {
          schema: TASK_SCHEMA, format: VALIDATION_FORMAT,
          taskId: task.taskId, sessionId, sessionKey: sessionKey(sessionId),
          title: task.title, kind: task.kind, requirement: task.requirement,
          logRefs: task.logRefs || [], codeHints: task.codeHints || [],
          changes: task.changes || [], checkpoints: task.checkpoints || [],
          installHandoff: task.installHandoff || null,
          handoffStatus: task.installHandoff ? (task.handoffStatus || 'awaiting-install') : (task.handoffStatus || 'draft'),
          revision: previous ? previous.revision + 1 : 1,
          createdAt: previous?.createdAt || now, updatedAt: now,
        };
        if (!previous && task.expectedRevision !== undefined) throw new Error('任务创建不能带 revision');
        await atomicJson(join(directory, 'task.json'), value);
        return value;
      });
    },

    async createAttempt(sessionId, taskId, attempt) {
      const directory = await ensure(attemptDir(sessionId, taskId, attempt.attemptId));
      return serialise(directory, async () => {
        const path = join(directory, 'attempt.json');
        if (await readJson(path)) throw new Error('attemptId 已存在');
        await mkdir(join(directory, 'evidence'), { recursive: true });
        await mkdir(join(directory, 'logs'), { recursive: true });
        const now = new Date().toISOString();
        const value = { schema: ATTEMPT_SCHEMA, format: VALIDATION_FORMAT, ...attempt, startedAt: attempt.startedAt || now, updatedAt: now };
        await atomicJson(path, value);
        return value;
      });
    },

    async readAttempt(sessionId, taskId, attemptId) {
      const real = await containedExisting(attemptDir(sessionId, taskId, attemptId));
      const value = await readSafeJson(real, 'attempt.json');
      if (!value) throw new Error('找不到该验证轮次');
      return value;
    },

    async updateAttempt(sessionId, taskId, attemptId, mutate) {
      const directory = await ensure(attemptDir(sessionId, taskId, attemptId));
      return serialise(directory + ':attempt', async () => {
        const path = join(directory, 'attempt.json');
        const previous = await readJson(path);
        if (!previous) throw new Error('找不到该验证轮次');
        const value = mutate({ ...previous }) || previous;
        value.updatedAt = new Date().toISOString();
        await atomicJson(path, value);
        return value;
      });
    },

    async listAttempts(sessionId, taskId) {
      const directory = join(taskDir(sessionId, taskId), 'attempts');
      const ids = await readdir(directory).catch(() => []);
      const attempts = [];
      for (const id of ids) {
        if (!attemptIdPattern.test(id)) continue;
        const attempt = await readJson(join(directory, id, 'attempt.json')).catch(() => undefined);
        if (attempt?.attemptId === id) attempts.push(attempt);
      }
      return attempts.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    },

    /** Append one event; seq is assigned here, monotonic per attempt. */
    async appendEvent(sessionId, taskId, attemptId, event) {
      const directory = await ensure(attemptDir(sessionId, taskId, attemptId));
      return serialise(directory + ':events', async () => {
        const path = join(directory, 'events.jsonl');
        // Sequence cache: appending used to re-read and parse the whole file
        // every time (O(n^2)). The cache is only trusted while the file size is
        // unchanged; anything else falls back to a full read.
        let cached = seqCache.get(path), tailGap = false;
        const info = await stat(path).catch(() => undefined);
        if (!cached || (info?.size ?? 0) !== cached.size) {
          const state = await readEventState(path);
          cached = { size: info?.size ?? 0, lastSeq: state.events.at(-1)?.seq || 0, tailGap: state.tailGap };
          seqCache.set(path, cached);
        }
        tailGap = cached.tailGap === true;
        const seq = cached.lastSeq + 1;
        const value = {
          schemaVersion: EVENT_SCHEMA, format: VALIDATION_FORMAT,
          seq, eventId: newId('ev'), taskId, attemptId,
          revision: event.revision,
          callId: event.callId ?? null, operationId: event.operationId ?? null, checkpointId: event.checkpointId ?? null,
          type: event.type, source: event.source || 'host',
          hostTime: event.hostTime || new Date().toISOString(), deviceTime: event.deviceTime ?? null,
          checkpointResult: event.checkpointResult ?? null,
          count: event.count ?? 1,
          data: event.data ?? null, error: event.error ?? null,
          evidence: event.evidence ?? [],
          metrics: event.metrics ?? null,
          dispatchState: event.dispatchState ?? 'unknown',
          effect: event.effect ?? 'unknown',
          verification: event.verification ?? 'not-run',
        };
        // A crashed tail is terminated instead of rewritten, so the half line
        // stays visible as a damaged line and the new event starts clean.
        const line = (tailGap ? '\n' : '') + JSON.stringify(value) + '\n';
        await appendFile(path, line);
        cached.size += Buffer.byteLength(line); cached.lastSeq = seq; cached.tailGap = false;
        return value;
      });
    },

    async readEvents(sessionId, taskId, attemptId, { afterSeq = 0, limit = 100 } = {}) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('事件游标无效');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('事件分页参数无效');
      const real = await containedExisting(attemptDir(sessionId, taskId, attemptId));
      const path = insideRoot(real, 'events.jsonl');
      const info = await lstat(path).catch(() => undefined);
      if (info?.isSymbolicLink()) throw new Error('事件文件不能是软链');
      const { events, tailGap, damaged } = await readEventState(path);
      const page = events.filter(event => event.seq > afterSeq).slice(0, limit);
      return {
        events: page, total: events.length, nextAfterSeq: page.length ? page.at(-1).seq : afterSeq,
        hasMore: events.some(event => event.seq > (page.at(-1)?.seq ?? afterSeq)),
        tailGap, damaged,
      };
    },

    /** All events for one call, across the whole file (no page limit). */
    async findEventsByCallId(sessionId, taskId, attemptId, callId) {
      if (!callId) return [];
      const { events } = await readEventState(join(attemptDir(sessionId, taskId, attemptId), 'events.jsonl'));
      return events.filter(event => event.callId === callId);
    },

    /** Full-file lookup for evidence references; not affected by page limits. */
    async findEvent(sessionId, taskId, attemptId, eventId) {
      const { events } = await readEventState(join(attemptDir(sessionId, taskId, attemptId), 'events.jsonl'));
      return events.find(event => event.eventId === eventId);
    },

    async writeEvidence(sessionId, taskId, attemptId, name, data) {
      if (!evidenceNamePattern.test(name || '')) throw new Error('证据文件名无效');
      const directory = await ensure(join(attemptDir(sessionId, taskId, attemptId), 'evidence'));
      const path = insideRoot(directory, name);
      const info = await lstat(path).catch(() => undefined);
      if (info) throw new Error('证据文件已存在，不能覆盖已有事实');
      await writeFile(path, data, { flag: 'wx' });
      return { name, bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') };
    },

    async evidencePath(sessionId, taskId, attemptId, name) {
      if (!evidenceNamePattern.test(name || '')) throw new Error('证据文件名无效');
      const directory = join(attemptDir(sessionId, taskId, attemptId), 'evidence');
      const real = await contained(directory);
      const path = insideRoot(real, name);
      const info = await lstat(path).catch(() => undefined);
      if (!info) throw new Error('找不到该证据文件');
      if (info.isSymbolicLink()) throw new Error('证据文件不能是软链');
      if (!info.isFile()) throw new Error('证据文件不可读');
      const final = await realpath(path);
      insideRoot(real, relative(real, final));
      return final;
    },

    /** Host restart: only new-format live attempts become interrupted. */
    async recoverInterrupted() {
      const sessions = await readdir(join(base, 'sessions')).catch(() => []);
      const recovered = [];
      for (const key of sessions) {
        const tasks = await readdir(join(base, 'sessions', key, 'tasks')).catch(() => []);
        for (const taskId of tasks) {
          if (!taskIdPattern.test(taskId)) continue;
          const attempts = await readdir(join(base, 'sessions', key, 'tasks', taskId, 'attempts')).catch(() => []);
          for (const attemptId of attempts) {
            if (!attemptIdPattern.test(attemptId)) continue;
            const path = join(base, 'sessions', key, 'tasks', taskId, 'attempts', attemptId, 'attempt.json');
            const attempt = await readJson(path).catch(() => undefined);
            if (!attempt || attempt.execution !== 'active') continue;
            const value = { ...attempt, execution: 'interrupted', interruptedReason: '宿主重启，未自动继续动作', updatedAt: new Date().toISOString() };
            await atomicJson(path, value);
            recovered.push({ taskId, attemptId });
          }
        }
      }
      return recovered;
    },
  };
}

/** Parse events.jsonl read-only, tolerating a crashed tail line. */
async function readEventState(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { events: [], tailGap: false, damaged: 0 }; throw error; }
  const lines = text.split('\n');
  const tail = lines.pop();
  const events = []; let damaged = 0, lastSeq = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (!Number.isSafeInteger(value.seq) || value.seq <= lastSeq) { damaged++; continue; }
      lastSeq = value.seq; events.push(value);
    } catch { damaged++; }
  }
  return { events, tailGap: !!tail, damaged };
}
