// Presentation models. Legacy report reading is kept for the existing history
// UI; validation-v1 rows and timelines are new and never claim more than the
// recorded facts (a tool success is not a pass, a missing log is not a defect).
export const statusLabels = { passed: '已通过', failed: '未通过', incomplete: '未完成', queued: '准备中', running: '进行中', cancelled: '已取消', interrupted: '已中断', skipped: '已跳过', blocked: '受阻', draft: '草稿', 'awaiting-install': '等待安装', 'ready-to-verify': '可验证', completed: '已完成' };
export const stageLabels = { preparing: '准备设备', observing: '读取页面', acting: '执行动作', thinking: '规划动作', verifying: '验证结果', finishing: '保存报告与释放控制' };

export function failureCategory(run) {
  if (['passed', 'queued', 'running'].includes(run.status)) return null;
  if (run.status === 'cancelled') return { label: '主动取消', suggestion: '确认设备状态后再创建验证轮次。' };
  if (run.status === 'interrupted') return { label: '宿主中断', suggestion: '检查设备及控制权，再创建验证轮次。' };
  if (run.status === 'incomplete') return { label: '必验项未完成', suggestion: '补齐未验证或缺少证据的检查点后重新结束验证；缺证据不能宣告通过。' };
  if (run.errorCode === 'VISION_UNAVAILABLE') return { label: '视觉验收不可用', suggestion: '当前模型未确认支持图像；选择支持图像的模型，不要把图片节点当作图片内容。' };
  const text = run.error || '';
  if (/429|quota|AccountQuotaExceeded|额度|MODEL_UNAVAILABLE|模型请求/i.test(text)) return { label: '模型服务不可用', suggestion: '检查当前会话模型的额度和服务状态。' };
  if (/控件|target node|LOCATOR|STALE|NODE_STALE/i.test(text)) return { label: '控件或页面变化', suggestion: '确认页面稳定，再调整检查点或目标。' };
  if (/设备|手机|控制权|lease|disconnect|HDC|解锁/i.test(text)) return { label: '设备连接或控制权', suggestion: '在 dshHarmony 检查连接、亮屏和占用状态。' };
  if (/日志目标|包名|应用名称|候选/.test(text)) return { label: '目标应用未确认', suggestion: '用 resolve_app 查询真实应用，不猜测包名。' };
  return { label: '结果未达预期或执行异常', suggestion: '结合事件、证据和日志确认原因；失败本身不能证明应用有缺陷。' };
}

/** Legacy report view (unchanged shape; only reads what the old runner saved). */
export function reportView(job, report) {
  const steps = [], screenshots = [], files = [];
  for (const result of report?.run?.results || []) for (const attempt of result.attempts || []) {
    for (const a of attempt.artifacts || []) { const path = typeof a === 'string' ? a : a.path; if (path) files.push({ label: a.kind || '证据文件', file: `e2e/${path}` }); }
    for (const s of attempt.steps || []) {
      const events = (s.events || []).slice(0, 150).map(e => ({ kind: e.kind || e.type, name: e.name, status: e.status, startedAt: e.startedAt, durationMs: e.durationMs, detail: typeof e.detail === 'string' ? e.detail.slice(0, 2000) : undefined, count: e.count }));
      const recordedActions = events.filter(e => e.kind === 'engine' && ['tap', 'fill', 'clear', 'focus', 'swipe', 'swipeTo', 'press', 'type'].includes(e.name)).reduce((n, e) => n + (e.count || 1), 0) + (s.kind === 'resource' && ['device.home', 'device.back'].includes(s.api) ? 1 : 0);
      const metrics = { ...s.metrics, modelCalls: s.metrics?.modelCalls ?? events.filter(e => e.kind === 'model').reduce((n, e) => n + (e.count || 1), 0), actionSteps: s.metrics?.actionSteps ?? recordedActions };
      steps.push({ id: s.id, index: steps.length + 1, kind: s.kind, label: s.label || s.api || s.kind, status: s.status, startedAt: s.startedAt, durationMs: s.durationMs, metrics, explanation: s.explanation, error: s.error?.message || (typeof s.error === 'string' ? s.error : undefined), events, screen: typeof s.screen === 'object' ? s.screen : undefined });
      for (const a of s.artifacts || []) { const path = typeof a === 'string' ? a : a.path; if (path) files.push({ label: s.label || '步骤证据', file: `e2e/${path}` }); }
    }
  }
  for (const a of job.evidence || []) files.push(a);
  const uniqueFiles = [...new Map(files.map(f => [f.file, f])).values()].filter(f => /\.(png|txt|md|json|log|xml|jsonl)$/i.test(f.file));
  for (const f of uniqueFiles) if (/\.png$/i.test(f.file)) screenshots.push(f);
  const totals = steps.reduce((a, s) => ({ modelCalls: a.modelCalls + (s.metrics?.modelCalls || 0), actions: a.actions + (s.metrics?.actionSteps || 0) }), { modelCalls: 0, actions: 0 });
  return { args: job.args, failure: failureCategory(job), steps, files: uniqueFiles, screenshots, totals, runnerSummary: report?.run?.summary, model: job.modelIdentity, progress: job.progress, evidenceWarnings: job.evidenceWarnings || [], reportWritten: !!report, logCollection: job.logCollection, cache: job.cache || [] };
}

function attemptStatus(attempt) {
  if (attempt.execution === 'cancelled') return 'cancelled';
  if (attempt.execution === 'interrupted') return 'interrupted';
  if (attempt.execution === 'active') return 'running';
  return attempt.semantic === 'passed' ? 'passed' : attempt.semantic === 'failed' ? 'failed' : 'incomplete';
}

/** validation-v1 attempt as a history row the existing list UI can render. */
export function validationRunView(task, attempt) {
  const status = attemptStatus(attempt);
  const checkpoints = attempt.checkpoints || [];
  const durationMs = attempt.completedAt ? Math.max(0, Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)) : null;
  return {
    id: `${task.taskId}/${attempt.attemptId}`, runId: attempt.attemptId, taskId: task.taskId, attemptId: attempt.attemptId,
    sessionId: attempt.sessionId || task.sessionId,
    format: 'validation-v1', kind: 'attempt', name: task.title, title: task.title,
    status, displayStatus: statusLabels[status] || status,
    execution: attempt.execution, mode: attempt.mode, semantic: attempt.semantic,
    taskRevision: attempt.taskRevision, contextRevision: attempt.contextRevision,
    createdAt: attempt.startedAt, startedAt: attempt.startedAt, completedAt: attempt.completedAt, updatedAt: attempt.updatedAt,
    durationMs,
    device: attempt.device?.name || attempt.device?.model || attempt.device?.serial,
    deviceInfo: attempt.device, installation: attempt.installation,
    checks: {
      checkpoints: { total: checkpoints.length, pass: checkpoints.filter(c => c.result === 'pass').length, fail: checkpoints.filter(c => c.result === 'fail').length, unverified: checkpoints.filter(c => c.result === 'unverified').length },
      leaseReleased: attempt.controlRelease?.released === true,
    },
    logIntegrity: attempt.logIntegrity, cleanup: attempt.cleanup, cleanupNote: attempt.cleanupNote || null,
    controlRelease: attempt.controlRelease || null, leaseCleanup: attempt.controlRelease?.released ? 'released-by-harmony' : (attempt.leaseCleanup || 'not-confirmed'),
    evidenceGaps: attempt.evidenceGaps || [], checkpoints,
    failure: failureCategory({ status, error: attempt.cancelReason }),
    legacy: { readOnly: false, dispatchState: 'per-event', effect: 'per-event', verification: 'checkpoint', logIntegrity: attempt.logIntegrity, cleanup: attempt.cleanup, leaseCleanup: attempt.controlRelease?.released ? 'released-by-harmony' : 'not-confirmed' },
    // Explicitly not measured: no hidden chain-of-thought, model calls or tokens.
    metrics: { modelCalls: '未采集', tokens: '未采集', durationMs },
  };
}

/** A task without any attempt is still a visible, non-active history row. */
export function validationTaskView(task) {
  const status = task.handoffStatus || 'draft';
  return {
    id: task.taskId, taskId: task.taskId, sessionId: task.sessionId, format: 'validation-v1', kind: 'task',
    name: task.title, title: task.title, status, displayStatus: statusLabels[status] || status,
    createdAt: task.createdAt, updatedAt: task.updatedAt, durationMs: null,
    requirement: task.requirement, revision: task.revision,
    checkpoints: task.checkpoints || [], installHandoff: task.installHandoff,
    attempts: (task.attempts || []).map(attempt => ({ attemptId: attempt.attemptId, execution: attempt.execution, semantic: attempt.semantic, startedAt: attempt.startedAt })),
    checks: { checkpoints: { total: (task.checkpoints || []).length } },
    metrics: { modelCalls: '未采集', tokens: '未采集', durationMs: null },
    legacy: { readOnly: false, dispatchState: 'unknown', effect: 'unknown', verification: 'checkpoint', logIntegrity: 'not-collected', cleanup: 'pending' },
  };
}

export function validationTimeline(task, attempt, events, gaps = {}) {
  const rows = events.map(event => ({
    seq: event.seq, eventId: event.eventId, type: event.type, source: event.source,
    hostTime: event.hostTime, deviceTime: event.deviceTime,
    callId: event.callId, operationId: event.operationId, checkpointId: event.checkpointId,
    summary: summariseEvent(event), data: event.data, error: event.error,
    dispatchState: event.dispatchState, effect: event.effect, verification: event.verification,
    evidence: event.evidence, metrics: event.metrics,
  }));
  return {
    run: validationRunView(task, attempt), checkpoints: attempt.checkpoints || [], events: rows,
    tailGap: !!gaps.tailGap, damagedEvents: gaps.damaged || 0,
    total: gaps.total ?? rows.length, hasMore: !!gaps.hasMore, nextAfterSeq: rows.at(-1)?.seq ?? 0,
    notes: [{ kind: 'scope', text: '只记录实际工具调用、公开摘要和证据；未采集宿主模型/终端/编辑器事件，不显示推理过程或伪造 Token/耗时。' }],
  };
}

/**
 * validation-v1 report as the legacy report-view shape, so the existing history
 * panel can render new attempts without a second UI. Numbers that were never
 * measured stay explicitly uncollected instead of being shown as zero.
 */
export function validationReportView(task, attempt, timeline = { events: [] }) {
  const checkpoints = attempt.checkpoints || [];
  const lifecycle = new Set(['attempt-started', 'attempt-finished', 'attempt-cancelled', 'attempt-interrupted', 'capture-started', 'capture-stopped']);
  const steps = (timeline.events || []).map((event, index) => ({
    id: `event-${event.seq}`, seq: event.seq, index: index + 1, kind: event.type,
    label: summariseEvent(event) || event.type,
    status: event.error ? 'failed' : (event.type === 'tool-start' || event.type === 'attempt-started' || event.type === 'capture-started') ? 'running' : 'passed',
    startedAt: event.hostTime, durationMs: null,
    metrics: { modelCalls: '未采集', actionSteps: event.type === 'tool-end' ? 1 : 0 },
    events: [],
    detail: event.error ? undefined : event.data,
    error: event.error?.message,
    dispatchState: event.dispatchState, effect: event.effect, verification: event.verification,
    evidence: event.evidence,
    source: event.source,
  }));
  const logStatus = { complete: 'captured', partial: 'partial', interrupted: 'partial', 'not-collected': 'unresolved', collecting: 'starting' }[attempt.logIntegrity] || 'unresolved';
  const run = validationRunView(task, attempt);
  return {
    args: {
      goal: task.requirement || task.title,
      expectation: checkpoints.map(checkpoint => `${checkpoint.id}：${checkpoint.description}`).join('\n'),
      runMode: 'validation', verificationMode: 'checkpoint',
    },
    failure: failureCategory(run),
    steps,
    files: [],
    screenshots: [],
    totals: { modelCalls: '未采集', actions: (timeline.events || []).filter(event => event.type === 'tool-end').length },
    runnerSummary: undefined,
    model: 'current-session',
    progress: undefined,
    evidenceWarnings: attempt.evidenceGaps || [],
    reportWritten: false,
    logCollection: { status: logStatus, warnings: [], target: attempt.device?.serial ? { label: attempt.device.serial } : undefined },
    cache: [],
    checkpoints,
    validation: timeline,
    notes: timeline.notes,
  };
}

export function summariseEvent(event) {
  if (event.type === 'tool-start') return `开始 ${event.data?.operation || '工具调用'}`;
  if (event.type === 'tool-end') return `${event.data?.operation || '工具调用'} ${event.error ? '返回错误' : '返回结果'}`;
  if (event.type === 'tool-end-late') return `${event.data?.operation || '工具调用'} 迟到回执（轮次已结束）`;
  if (event.type === 'observation') return '设备观察';
  if (event.type === 'checkpoint-recorded') return `检查点 ${event.checkpointId}：${event.checkpointResult}`;
  if (event.type === 'attempt-started') return `开始验证（${event.data?.mode || 'ai'}）`;
  if (event.type === 'attempt-finished') return `结束验证（${event.data?.semantic || '?'}，清理 ${event.data?.cleanup || '?'}）`;
  if (event.type === 'attempt-cancelled') return '取消验证';
  if (event.type === 'attempt-interrupted') return '验证中断';
  if (event.type === 'capture-started') return '开始设备日志采集';
  if (event.type === 'capture-stopped') return '停止设备日志采集';
  if (event.type === 'capture-attached') return '关联独立采集';
  if (event.type === 'evidence-saved') return '保存观察证据';
  return event.type;
}
