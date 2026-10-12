export const statusLabels = { passed: '已通过', failed: '未通过', queued: '准备中', running: '进行中', cancelled: '已取消', interrupted: '已中断', skipped: '已跳过', blocked: '受阻' };
export const stageLabels = { preparing: '准备设备', observing: '读取页面', acting: '执行动作', thinking: '规划动作', verifying: '验证结果', finishing: '保存报告与释放控制' };
export function failureCategory(run) {
  if (['passed','queued','running'].includes(run.status)) return null;
  if (run.status === 'cancelled') return { label: '主动取消', suggestion: '确认设备状态后再创建新测试。' };
  if (run.status === 'interrupted') return { label: '宿主中断', suggestion: '检查设备及控制权，再创建复测。' };
  const text = run.error || '';
  if (/429|quota|AccountQuotaExceeded|额度|MODEL_UNAVAILABLE|模型请求/i.test(text)) return { label: '模型服务不可用', suggestion: '检查当前会话模型的额度和服务状态。' };
  if (/预算|调用次数|budget|时间限制|timeout|timed out/i.test(text)) return { label: '执行预算耗尽', suggestion: '缩小任务目标；必要时在复测中调整预算。' };
  if (/控件|target node|LOCATOR|STALE|NODE_STALE/i.test(text)) return { label: '控件或页面变化', suggestion: '确认页面稳定，再调整任务步骤或目标。' };
  if (/设备|手机|控制权|lease|disconnect|HDC|解锁/i.test(text)) return { label: '设备连接或控制权', suggestion: '在 dshHarmony 检查连接、亮屏和占用状态。' };
  if (/日志目标|包名|应用名称|候选/.test(text)) return { label: '目标应用未确认', suggestion: '用 resolve_app 查询真实应用，不猜测包名。' };
  if (/模型动作无法解析|JSON|output/i.test(text)) return { label: '模型输出异常', suggestion: '检查模型响应，避免自动重复未知效果的动作。' };
  return { label: '结果未达预期或执行异常', suggestion: '结合步骤和日志确认原因；失败本身不能证明应用有缺陷。' };
}
export function reportView(job, report) {
  const steps = [], screenshots = [], files = [];
  for (const result of report?.run?.results || []) for (const attempt of result.attempts || []) {
    for (const a of attempt.artifacts || []) { const path = typeof a === 'string' ? a : a.path; if (path) files.push({ label: a.kind || '证据文件', file: `e2e/${path}` }); }
    for (const s of attempt.steps || []) {
      const events = (s.events || []).slice(0, 150).map(e => ({ kind: e.kind || e.type, name: e.name, status: e.status, startedAt: e.startedAt, durationMs: e.durationMs, detail: typeof e.detail === 'string' ? e.detail.slice(0, 2000) : undefined, count: e.count }));
      const recordedActions = events.filter(e => e.kind === 'engine' && ['tap','fill','clear','focus','swipe','swipeTo','press','type'].includes(e.name)).reduce((n,e) => n + (e.count || 1), 0) + (s.kind === 'resource' && ['device.home','device.back'].includes(s.api) ? 1 : 0);
      const metrics = { ...s.metrics, modelCalls: s.metrics?.modelCalls ?? events.filter(e=>e.kind==='model').reduce((n,e)=>n+(e.count||1),0), actionSteps: s.metrics?.actionSteps ?? recordedActions };
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
