import { createContext } from 'react';
export type LogSnapshot = { bundle: string; serial: string; filters: Record<string, unknown>; capturedAt: string; count: number; firstTimestamp?: string; lastTimestamp?: string; dropped: number; evicted: number };
export const LogSessionContext = createContext<{ sessionId?: string; onOpenLogs?: (id: string) => void; onAnalyze?: (text: string) => void }>({});
export async function saveSessionLog(file: File, sessionId: string, snapshot: LogSnapshot, signal: AbortSignal) {
  if (!sessionId || !file.size || file.size > 32 * 1024 * 1024) throw Error('请在会话中保存 1 字节～32 MiB 的日志');
  const url = (path: string, params = {}) => '/api/dsh-e2e/log-library/' + path + '?' + new URLSearchParams({ sessionId, ...params });
  const json = async (path: string, body: unknown, params = {}, raw = false, cancellable = true) => {
    const response = await fetch(url(path, params), { method: 'POST', headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' }, body: raw ? body as BodyInit : JSON.stringify(body), signal: cancellable ? signal : undefined });
    const value = await response.json().catch(() => ({}));
    if (!response.ok || value.error) throw Error(value.error || '会话日志库不可用，请启用匹配版本的 dshE2E 并完整重启宿主');
    return value;
  };
  let id: string | undefined;
  try {
    const capabilities = await fetch(url('capabilities'), { signal }).then(async response => response.ok ? response.json() : undefined);
    if (capabilities?.protocolVersion !== 2 || capabilities?.sessionId !== sessionId) throw Error('会话保存需要新版 dshE2E 日志库，请成对更新两个插件并完整重启宿主');
    signal.throwIfAborted(); const started = await json('begin', { name: file.name, size: file.size, sourceKind: 'realtime', snapshot }, {}, false, false); id = started.id;
    for (let at = 0, index = 0; at < file.size; at += 256 * 1024) { signal.throwIfAborted(); await json('chunk', await file.slice(at, at + 256 * 1024).arrayBuffer(), { id, index: String(index++) }, true); }
    signal.throwIfAborted(); return await json('finish', { id });
  } catch (error) { if (id) await json('abort', { id }, {}, false, false).catch(() => {}); throw error; }
}
export function appendAnalysisDraft(input: any, text: string) {
  const state = input.state?.getSnapshot?.();
  if (!state) throw Error('当前宿主未提供草稿读取能力，请完整重启后重试');
  if (state.phase !== 'plain') throw Error('当前输入正在提交或处理命令，请稍后填入分析草稿');
  if (state.occurrences?.length) throw Error('已有草稿包含引用，请先保存或发送它，再填入日志分析模板');
  input.setDraft(state.draft ? state.draft + '\n\n' + text : text); input.focus?.();
}
