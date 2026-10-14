export function libraryUrl(sessionId, path, params = {}) {
  if (!sessionId) throw Error('请先打开一个会话');
  return '/api/dsh-e2e/log-library/' + path + '?' + new URLSearchParams({ sessionId, ...params });
}
export async function libraryRequest(sessionId, path, { params, body, rawBody, ...options } = {}) {
  const response = await fetch(libraryUrl(sessionId, path, params), rawBody !== undefined ? { ...options, body: rawBody } : body === undefined ? options : { ...options, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.error) throw Error(value.error || '日志库不可用，请确认 dshE2E 已启用并完整重启宿主');
  return value;
}
export async function importLogFile(file, sessionId, { signal, onProgress = () => {}, sourceKind = 'import', snapshot } = {}) {
  if (!file.size || file.size > 32 * 1024 * 1024) throw Error('每份日志需为 1 字节～32 MiB 的 UTF-8 文件');
  let id;
  try {
    signal?.throwIfAborted();
    // Keep begin observable even if cancellation arrives while the server creates it.
    const started = await libraryRequest(sessionId, 'begin', { body: { name: file.name, size: file.size, sourceKind, snapshot } }); id = started.id;
    for (let start = 0, index = 0; start < file.size; start += 256 * 1024) {
      signal?.throwIfAborted(); const data = await file.slice(start, start + 256 * 1024).arrayBuffer();
      const result = await libraryRequest(sessionId, 'chunk', { params: { id, index: index++ }, method: 'POST', headers: { 'content-type': 'application/octet-stream' }, rawBody: data, signal });
      onProgress(result.received, file.size, '上传中');
    }
    signal?.throwIfAborted(); onProgress(file.size, file.size, '解析中');
    const value = await libraryRequest(sessionId, 'finish', { body: { id }, signal });
    return value;
  } catch (error) { if (id) await libraryRequest(sessionId, 'abort', { body: { id } }).catch(() => {}); throw error; }
}
export function logAnalysisPrompt(file, row, filters = {}) {
  const line = row?.sourceLine;
  const labels = { query: '关键词', level: '级别', tag: 'TAG', domain: 'DOMAIN', pid: 'PID', tid: 'TID', from: '开始时间', until: '结束时间', regex: '正则', caseSensitive: '区分大小写' };
  const scope = line ? '' : Object.entries(filters).filter(([key, value]) => labels[key] && value !== '' && value !== false && value !== undefined)
    .map(([key, value]) => `${labels[key]}=${value === true ? '开启' : value}`).join('，');
  return `${line ? '请分析当前会话日志中的这一行' : '请分析当前会话中的日志'}，只分析日志，不操作手机或重新执行测试。\n\n文件：${file.name}\n日志文件 ID：${file.id}\n来源：${file.sourceKind === 'realtime' ? '实时保存' : '导入'}\n应用：${file.snapshot?.bundle || '未指定'}${line ? `\n原文件行号：${line}\n日志内容：${String(row.raw || row.message || '').slice(0, 500)}` : scope ? `\n筛选范围：${scope}` : ''}\n\n现象 / Bug 描述：\n其它补充：`;
}
export function appendLogDraft(input, text) {
  const state = input.state?.getSnapshot?.();
  if (!state) throw Error('当前宿主未提供草稿读取能力，请完整重启后重试');
  if (state.phase !== 'plain') throw Error('当前输入正在提交或处理命令，请稍后填入分析草稿');
  if (state.occurrences?.length) throw Error('已有草稿包含引用，请先保存或发送它，再填入日志分析模板');
  input.setDraft(state.draft ? state.draft + '\n\n' + text : text);
  input.focus?.();
}
