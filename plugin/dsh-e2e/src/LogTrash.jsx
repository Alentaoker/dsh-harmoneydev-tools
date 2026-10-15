import React, { useEffect, useState } from 'react';
import { libraryRequest as request } from './log-client.mjs';
export function LogTrash({ sessionId, visible, onChanged, onClose }) {
  const [page, setPage] = useState(), [usage, setUsage] = useState(), [offset, setOffset] = useState(0), [tick, setTick] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState();
  useEffect(() => { if (!visible) return; const abort = new AbortController(); Promise.all([request(sessionId, 'trash', { params: { offset, limit: 20 }, signal: abort.signal }), request(sessionId, 'usage', { signal: abort.signal })]).then(([files, space]) => { if (!abort.signal.aborted) { setPage(files); setUsage(space); if (offset && offset >= files.total) setOffset(0); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); }); return () => abort.abort(); }, [sessionId, visible, offset, tick]);
  async function mutate(path, body) { setBusy(true); setError(''); try { const value = await request(sessionId, path, { body }); setConfirm(undefined); setTick(t => t + 1); onChanged(); if (value.errors.length) setError(`${value.errors.length} 份日志未完成，请稍后重试`); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const size = bytes => (bytes / 1048576).toFixed(2) + ' MiB';
  return <section className="box log-trash" aria-label="当前会话回收区"><div className="row spread"><strong>当前会话回收区</strong><button onClick={onClose}>关闭</button></div>
    {usage && <p className="muted">暂存正文 {usage.files} 份 / {size(usage.bytes)} · 回收正文 {usage.trashFiles} 份 / {size(usage.trashBytes)}<br/>AI 分析缓存 {size(usage.analysisCacheBytes || 0)} · 不含索引和导入临时文件。</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {confirm && <div role="alertdialog" className="notice error"><strong>永久清空当前会话回收区中的 {confirm.count} 份日志？</strong><p>此操作无法撤销。源文件、当前暂存文件和其他会话保留。</p><div className="row"><button disabled={busy} onClick={() => mutate('purge', { confirm: true, before: confirm.before })}>永久清空</button><button disabled={busy} onClick={() => setConfirm(undefined)}>取消</button></div></div>}
    {!page ? <p>正在读取回收区…</p> : !page.files.length ? <p className="muted">回收区为空</p> : <>{page.files.map(file => <div className="trash-row" key={file.id}><div><strong>{file.name}</strong><div className="muted">{new Date(file.deletedAt).toLocaleString('zh-CN')} · {size(file.storedBytes ?? file.size + (file.normalizedBytes || 0))}</div></div><button disabled={busy} onClick={() => mutate('restore', { batchId: file.batchId, ids: [file.id] })}>恢复</button></div>)}<div className="row pager"><button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>{page.total} 份</span><button disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset)}>下一页</button></div></>}
    <button disabled={busy || !usage?.analysisCacheBytes} onClick={() => mutate('clear-analysis-cache', {})}>清理 AI 分析缓存</button><p className="muted">仅删除按需生成的可读副本；日志和原包保留，已有草稿中的正文路径需重新生成。</p>
    <button disabled={!page?.total || busy} onClick={() => setConfirm({ count: page.total, before: page.snapshotBefore })}>清空回收区…</button>
  </section>;
}
