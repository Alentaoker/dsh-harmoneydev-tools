// Independent log CaptureSession.
//
// Owns its own AbortController and lifecycle: it does not depend on a runner
// job, an engine attempt, or a control lease. It can run before a validation
// attempt exists and be attached afterwards; stopping is idempotent, and a host
// restart only ever marks it interrupted (never auto-resumes).
import { redactLog, logTime, processMatches } from './logs.mjs';

export const CAPTURE_STATUS = ['starting', 'capturing', 'captured', 'empty', 'unconfirmed', 'failed', 'partial', 'cancelled'];

export function captureStatusLabel(status) {
  return { starting: '正在连接日志', capturing: '正在采集', captured: '已采集', empty: '已连接，未收到目标日志', unconfirmed: '未确认日志流就绪', failed: '采集失败', partial: '采集不完整', cancelled: '已取消' }[status] || status;
}

/**
 * @param {object} options
 * @param {object} options.manager     Harmony manager (streamLogs/listProcesses/readLogs)
 * @param {string} options.serial
 * @param {{bundleName:string,label?:string,process?:string,source?:string}} options.target
 * @param {object} options.sink        { logs, pendingLogs, logBytes, pendingLogBytes, logCollection, logArchive }
 * @param {number} [options.maximumBytes] memory ring limit
 */
export function createCaptureSession({ manager, serial, target, sink, maximumBytes = 2 * 1024 * 1024, maximumEntries = 1000, signal, owner = {}, now = () => Date.now() }) {
  const controller = new AbortController();
  const info = sink.logCollection = {
    captureId: `cap-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'starting', mode: 'live', startedAt: new Date().toISOString(),
    owner, target, pids: [], observedPids: [], retained: 0, dropped: 0, excludedHistory: 0,
    boundary: 'receive-time-only', streamConfirmed: false, warnings: [],
    limits: { memoryBytes: maximumBytes, memoryEntries: maximumEntries },
    deviceTimeBasis: 'device-timestamp-unparsed', hostTimeBasis: 'host-receive',
  };
  let cutoff, streamPromise, refreshPromise, finishing = false, resolveReady, stopTimer, timer, abortHandler;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const current = new Map(), observed = new Set();
  const external = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const safe = text => redactLog(text, [serial, owner.leaseToken]);

  function warning(message) { const value = safe(message); if (!info.warnings.includes(value)) info.warnings.push(value); }

  async function refresh() {
    if (refreshPromise || finishing || external.aborted) return refreshPromise;
    const refreshSignal = AbortSignal.any([external, AbortSignal.timeout(15000)]);
    refreshPromise = (async () => {
      try {
        const processes = await manager.listProcesses(serial, refreshSignal);
        if (finishing) return;
        current.clear(); for (const process of processes) current.set(process.pid, process.name);
        info.pids = processes.filter(p => processMatches(p.name, target)).map(p => p.pid);
        for (const pid of info.pids) observed.add(pid);
        info.observedPids = [...observed];
        // PID reuse protection: a pid that now belongs to another app is dropped
        // from the observed set and never used for attribution again.
        for (const pid of [...observed]) {
          const name = current.get(pid);
          if (name && !processMatches(name, target)) observed.delete(pid);
        }
      } catch (error) {
        if (!external.aborted) {
          if (refreshSignal.aborted && refreshSignal.reason?.name === 'TimeoutError') info.refreshDeferred = (info.refreshDeferred || 0) + 1;
          else warning(`目标进程刷新失败：${error.message}`);
        }
      } finally { refreshPromise = undefined; }
    })();
    return refreshPromise;
  }

  function accept(entries) {
    if (finishing) return;
    info.streamConfirmed = true; info.status = 'capturing'; resolveReady();
    for (const entry of entries) {
      const knownName = current.get(entry.pid);
      const pidMatch = knownName ? processMatches(knownName, target) : observed.has(entry.pid);
      const bundleMatch = new RegExp(`(?:^|[^A-Za-z0-9_.])${target.bundleName.replaceAll('.', '\\.')}($|[^A-Za-z0-9_.])`).test(`${entry.tag || ''} ${entry.message || ''}`);
      if (!pidMatch && !bundleMatch) continue;
      const time = logTime(entry.timestamp);
      if (cutoff !== undefined && (time === undefined || time <= cutoff)) { info.excludedHistory++; continue; }
      const captured = { ...entry, message: safe(entry.message), raw: safe(entry.raw), tag: safe(entry.tag), capturedAt: new Date().toISOString() };
      const size = Buffer.byteLength(JSON.stringify(captured));
      sink.logs.push(captured); sink.pendingLogs.push(captured); sink.logArchive?.enqueue(captured);
      sink.logBytes = (sink.logBytes || 0) + size; sink.pendingLogBytes = (sink.pendingLogBytes || 0) + size;
      while (sink.logs.length && sink.logBytes > maximumBytes) { sink.logBytes -= Buffer.byteLength(JSON.stringify(sink.logs.shift())); info.dropped++; }
      while (sink.pendingLogs.length && sink.pendingLogBytes > maximumBytes) sink.pendingLogBytes -= Buffer.byteLength(JSON.stringify(sink.pendingLogs.shift()));
      if (sink.logs.length > maximumEntries) { sink.logBytes -= Buffer.byteLength(JSON.stringify(sink.logs.shift())); info.dropped++; }
      if (sink.pendingLogs.length > maximumEntries) sink.pendingLogBytes -= Buffer.byteLength(JSON.stringify(sink.pendingLogs.shift()));
    }
    info.retained = sink.logs.length; info.memoryBytes = sink.logBytes || 0;
  }

  async function start() {
    await refresh();
    try {
      const baseline = await manager.readLogs({ serial, limit: 200, signal: AbortSignal.any([external, AbortSignal.timeout(5000)]) });
      const times = baseline.map(entry => logTime(entry.timestamp)).filter(Number.isFinite);
      if (times.length) { cutoff = Math.max(...times); info.boundary = 'device-log-watermark'; info.watermark = baseline.find(entry => logTime(entry.timestamp) === cutoff)?.timestamp; }
      else warning('未获得设备日志时间边界，日志按收到时间记录，可能包含启动时缓冲的历史条目');
    } catch (error) {
      if (external.aborted) throw error;
      warning(`未获得设备日志时间边界：${error.message}；可能包含缓冲历史日志`);
    }
    external.throwIfAborted();
    abortHandler = () => controller.abort(); external.addEventListener('abort', abortHandler, { once: true });
    try {
      streamPromise = Promise.resolve(manager.streamLogs(serial, accept, controller.signal)).then(() => {
        if (!controller.signal.aborted) { info.status = 'failed'; warning('设备日志流意外结束'); }
      }).catch(error => { if (!controller.signal.aborted) { info.status = 'failed'; warning(`设备日志采集失败：${error.message}`); } }).finally(resolveReady);
    } catch (error) { info.status = 'failed'; warning(`设备日志采集失败：${error.message}`); resolveReady(); }
    timer = setInterval(() => void refresh(), 2000); timer.unref?.();
    await Promise.race([ready, new Promise(resolve => { stopTimer = setTimeout(resolve, 1000); })]);
    clearTimeout(stopTimer);
    return { refresh, stop, cancel, status: () => info };
  }

  function stopTimers() {
    if (timer) { clearInterval(timer); timer = undefined; }
    if (abortHandler) { external.removeEventListener('abort', abortHandler); abortHandler = undefined; }
  }

  function finaliseIntegrity() {
    info.completedAt = new Date().toISOString();
    info.retained = sink.logs.length; info.memoryBytes = sink.logBytes || 0;
    if (!info.observedPids.length) warning('未观察到目标应用进程；仅保存明确包含目标包名的条目');
    if (info.dropped) warning(`内存仅保留最近 ${maximumEntries} 条 / ${Math.round(maximumBytes / 1024 / 1024)} MiB；${info.dropped} 条较早日志请分页读取磁盘正文`);
    // Integrity is decided after the archive is closed: a final disk failure,
    // dropped lines, or an unconfirmed stream is never reported as complete.
    if (info.status === 'cancelled') info.integrity = 'interrupted';
    else if (info.status === 'captured' && !info.diskDropped && !info.queueDropped && !info.closeError) info.integrity = 'complete';
    else info.integrity = 'partial';
  }

  async function stop() {
    if (finishing) return info;
    finishing = true; controller.abort(); stopTimers();
    let cleanupTimer;
    await Promise.race([Promise.allSettled([streamPromise, refreshPromise]), new Promise(resolve => { cleanupTimer = setTimeout(() => { warning('日志连接关闭超时'); resolve(); }, 1500); })]);
    clearTimeout(cleanupTimer);
    if (info.status === 'failed' || info.diskDropped || info.queueDropped) info.status = sink.logs.length ? 'partial' : 'failed';
    else info.status = sink.logs.length ? 'captured' : info.streamConfirmed ? 'empty' : 'unconfirmed';
    try { await sink.logArchive?.close(); } catch (error) { info.closeError = error.message; warning(`日志归档收尾失败：${error.message}`); }
    finaliseIntegrity();
    return info;
  }

  async function cancel(reason = '用户取消采集') {
    if (info.status === 'cancelled') return info;
    info.cancelReason = reason; controller.abort(reason); finishing = true; stopTimers();
    try { await sink.logArchive?.close(); } catch (error) { info.closeError = error.message; warning(`日志归档收尾失败：${error.message}`); }
    info.status = 'cancelled';
    finaliseIntegrity();
    return info;
  }

  return { info, start, stop, cancel, refresh, signal: external, captureId: info.captureId };
}
