import React, { useEffect, useRef, useState } from 'react';
import { libraryRequest as request } from './log-client.mjs';

const size = value => value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GiB' : (value / 1048576).toFixed(2) + ' MiB';
const labels = { delete: '移入回收区', restore: '恢复回收日志', purge: '永久删除回收日志' };

export function LogSessionManager({ sessionId, visible, onClose, onChanged }) {
  const [page, setPage] = useState(), [query, setQuery] = useState(''), [debounced, setDebounced] = useState(''), [offset, setOffset] = useState(0), [tick, setTick] = useState(0);
  const [selected, setSelected] = useState(new Set()), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [plan, setPlan] = useState(), [phrase, setPhrase] = useState('');
  const alive = useRef(false), running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const timer = setTimeout(() => { setDebounced(query); setOffset(0); }, 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setSelected(new Set()); }, [debounced]);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController(); setLoading(true); setError('');
    request(sessionId, 'management/sessions', { params: { query: debounced, offset, limit: 50 }, signal: abort.signal }).then(value => {
      if (abort.signal.aborted) return;
      setPage(value); if (offset && offset >= value.total) setOffset(0);
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [sessionId, visible, debounced, offset, tick]);
  async function prepare(action) {
    if (running.current || !selected.size) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try { const value = await request(sessionId, 'management/prepare', { body: { action, sessionIds: [...selected] } }); if (alive.current) { setPlan(value); setPhrase(''); } }
    catch (error) { if (alive.current) setError(error.message); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  async function execute() {
    if (running.current || !plan || plan.action === 'purge' && phrase !== '删除') return;
    running.current = true; setBusy(true); setError('');
    try {
      const result = await request(sessionId, 'management/execute', { body: { token: plan.token, confirm: true } });
      if (!alive.current) return;
      setPlan(undefined); setSelected(new Set()); setTick(value => value + 1); onChanged(result);
      setNotice(result.action === 'restore' ? `已恢复 ${result.restored} 份日志。` : result.action === 'purge' ? `已永久删除 ${result.removed} 份回收日志。` : `已将 ${result.removed} 份日志移入各自会话的回收区，可在这里选择会话恢复。`);
      if (result.errors.length) setError(result.errors.map(row => `${row.sessionId}${row.id ? ' / ' + row.id : ''}：${row.error}`).join('\n'));
    } catch (error) { if (alive.current) { setError(error.message); setPlan(undefined); setTick(value => value + 1); } }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  const allPage = !!page?.sessions.length && page.sessions.every(row => selected.has(row.sessionId));
  return <section className="log-session-manager" aria-label="全部会话日志管理" aria-busy={busy || loading}>
    <header className="row spread"><h3>全部会话日志管理</h3><button disabled={busy} onClick={onClose}>返回当前会话</button></header>
    <p className="muted">统一清理本机所有会话的离线日志；会话对话、开发验证记录、截图与录屏保留。普通阅读和搜索仍按会话隔离。</p>
    <div className="row log-manager-tools"><input aria-label="搜索日志所属会话" placeholder="搜索会话名称或 ID" maxLength={256} disabled={busy || !!plan} value={query} onChange={event => setQuery(event.target.value)}/><button disabled={busy || loading || !!plan} onClick={() => setTick(value => value + 1)}>刷新会话</button><span>已选 {selected.size} 个会话{selected.size ? '（含其它分页）' : ''}</span><button disabled={busy || !!plan || !selected.size} onClick={() => setSelected(new Set())}>取消选择</button></div>
    {page && <p className="muted">筛选范围：{page.total} 个会话 · 暂存 {page.totals.files} 份 / {size(page.totals.bytes)} · 回收区 {page.totals.trashFiles} 份 / {size(page.totals.trashBytes)}。空间为正文和原包估算，不含索引、临时文件及文件系统开销。</p>}
    <div className="row log-manager-actions"><button disabled={busy || !!plan || !selected.size} onClick={() => prepare('delete')}>所选日志移入回收区…</button><button disabled={busy || !!plan || !selected.size} onClick={() => prepare('restore')}>恢复所选回收日志…</button><button disabled={busy || !!plan || !selected.size} onClick={() => prepare('purge')}>永久清空所选回收区…</button></div>
    <p className="muted">移入回收区不会释放磁盘空间；确认不再需要后，可永久清空回收区释放空间。每次最多处理 200 个会话、10000 份日志；导入或解析中的会话会跳过并提示。</p>
    {error && <p role="alert" className="notice error log-manager-error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {plan && <section className="notice log-manager-confirm" role="alertdialog" aria-label="确认跨会话日志清理" aria-describedby="log-manager-confirm-description">
      <strong>{labels[plan.action]}：{plan.sessionCount} 个会话、{plan.count} 份日志（约 {size(plan.bytes)}）？</strong>
      <p id="log-manager-confirm-description">{plan.action === 'purge' ? '永久删除无法撤销；只处理这次确认列表中的回收日志。' : plan.action === 'delete' ? '移入各自会话的回收区，支持恢复。' : '恢复到日志原所属会话。'}确认后新导入或新移入回收区的日志不会加入本次操作。</p>
      <ul>{plan.sessions.map(row => <li key={row.sessionId}>{row.name} · {row.count} 份 <small>（{row.sessionId}）</small></li>)}</ul>
      {plan.action === 'purge' && <label>输入“删除”以确认永久清空 <input aria-label="永久清空确认文字" autoComplete="off" disabled={busy} value={phrase} onChange={event => setPhrase(event.target.value)}/></label>}
      <div className="row"><button disabled={busy || plan.action === 'purge' && phrase !== '删除'} onClick={execute}>{busy ? '正在处理…' : `确认${labels[plan.action]}`}</button><button disabled={busy} onClick={() => setPlan(undefined)}>取消</button></div>
    </section>}
    <div className="log-manager-table-scroll"><table className="log-manager-table"><thead><tr><th><input type="checkbox" aria-label="全选本页会话" disabled={busy || loading || !!plan || !page?.sessions.length} checked={allPage} onChange={event => setSelected(values => { const next = new Set(values); for (const row of page.sessions) event.target.checked ? next.add(row.sessionId) : next.delete(row.sessionId); return next; })}/></th><th>会话</th><th>暂存日志</th><th>回收区</th><th>最近导入</th></tr></thead><tbody>
      {page?.sessions.map(row => <tr key={row.sessionId}><td><input type="checkbox" aria-label={'选择会话 ' + row.name} disabled={busy || loading || !!plan} checked={selected.has(row.sessionId)} onChange={event => setSelected(values => { const next = new Set(values); event.target.checked ? next.add(row.sessionId) : next.delete(row.sessionId); return next; })}/></td><td><strong>{row.name}</strong>{row.sessionId === sessionId && <span className="badge">当前会话</span>}<small>{row.sessionId}{!row.nameAvailable && ' · 会话名称不可用'}</small></td><td>{row.files} 份<br/>{size(row.bytes)}</td><td>{row.trashFiles} 份<br/>{size(row.trashBytes)}</td><td>{row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN') : '—'}</td></tr>)}
    </tbody></table>{!loading && page && !page.sessions.length && <p className="empty">没有符合条件的会话日志。</p>}{loading && <p role="status">正在统计会话日志…</p>}</div>
    <footer className="row spread"><button disabled={busy || loading || !!plan || !offset} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><span>{page ? `${page.total} 个会话 · 第 ${Math.floor(offset / 50) + 1} 页` : ''}</span><button disabled={busy || loading || !!plan || !page || page.nextOffset === null} onClick={() => setOffset(page.nextOffset)}>下一页</button></footer>
  </section>;
}
