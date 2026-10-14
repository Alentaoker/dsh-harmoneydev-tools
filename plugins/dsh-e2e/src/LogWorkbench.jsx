import React, { useEffect, useRef, useState } from 'react';
import { LogViewer } from './LogViewer.jsx';
import { LogTrash } from './LogTrash.jsx';
import { libraryRequest as request, libraryUrl, importLogFile, logAnalysisPrompt } from './log-client.mjs';

export function LogWorkbench({ visible, sessionId, onDraft, openFileId }) {
  const [pageState, setPage] = useState(), [offset, setOffset] = useState(0), [selectedState, setSelected] = useState(), [query, setQuery] = useState(''), [debounced, setDebounced] = useState('');
  const page = pageState?.sessionId === sessionId ? pageState : undefined, selected = selectedState?.sessionId === sessionId ? selectedState : undefined;
  const [checked, setChecked] = useState(new Set()), [all, setAll] = useState(), [queue, setQueue] = useState([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [tick, setTick] = useState(0), [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false), [undo, setUndo] = useState(), [confirm, setConfirm] = useState(), [legacy, setLegacy] = useState(), [legacyOpen, setLegacyOpen] = useState(false), [listWidth, setListWidth] = useState(32);
  const [sourceKind, setSourceKind] = useState(''), [sort, setSort] = useState('newest'), [renaming, setRenaming] = useState(), [trashOpen, setTrashOpen] = useState(false);
  const retryFiles = useRef(new Map());
  const input = useRef(), currentSession = useRef(sessionId), waiting = useRef([]), running = useRef(false), controller = useRef(), mounted = useRef(true), dragDepth = useRef(0), split = useRef();
  currentSession.current = sessionId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; waiting.current = []; controller.current?.abort.abort(); }; }, []);
  useEffect(() => { setOffset(0); setPage(undefined); setSelected(undefined); setChecked(new Set()); setAll(undefined); setQuery(''); setDebounced(''); setError(''); setNotice(''); setUndo(undefined); setConfirm(undefined); setBusy(false); setLegacy(undefined); setLegacyOpen(false); setSourceKind(''); setSort('newest'); setRenaming(undefined); setTrashOpen(false); }, [sessionId]);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setOffset(0); setChecked(new Set()); setAll(undefined); }, [debounced, sourceKind, sort]);
  useEffect(() => {
    if (!visible || !sessionId) return; const abort = new AbortController();
    setPage(undefined); request(sessionId, 'list', { params: { offset, limit: 20, query: debounced, sourceKind, sort }, signal: abort.signal }).then(value => { if (value.protocolVersion !== 2 || value.sessionId !== sessionId) throw Error('后端日志库仍是旧版，请成对更新两个插件并完整重启宿主'); if (!abort.signal.aborted) { setPage(value); if (offset >= value.total && offset) setOffset(Math.max(0, Math.floor((value.total - 1) / 20) * 20)); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [visible, sessionId, offset, debounced, sourceKind, sort, tick]);
  useEffect(() => {
    if (!visible || !sessionId || !openFileId) return; const abort = new AbortController();
    request(sessionId, 'info', { params: { id: openFileId }, signal: abort.signal }).then(value => { if (!abort.signal.aborted) { setSelected(value); setTick(t => t + 1); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [visible, sessionId, openFileId]);
  const updateItem = (id, patch) => { if (mounted.current) setQueue(items => items.map(item => item.id === id ? { ...item, ...patch } : item)); };
  async function drain() {
    if (running.current) return; running.current = true;
    try {
      while (waiting.current.length && mounted.current) {
        const item = waiting.current.shift(), abort = new AbortController(); controller.current = { abort, sessionId: item.sessionId };
        updateItem(item.id, { phase: '上传中' });
        try {
          const file = await importLogFile(item.file, item.sessionId, { signal: abort.signal, onProgress: (bytes, size, phase) => updateItem(item.id, { bytes, size, phase }) });
          updateItem(item.id, { phase: '完成' }); retryFiles.current.delete(item.id);
          if (mounted.current && currentSession.current === item.sessionId) { setSelected(file); setTick(t => t + 1); setOffset(0); }
        } catch (e) { updateItem(item.id, { phase: e.name === 'AbortError' ? '已取消' : '失败', error: e.name === 'AbortError' ? '' : e.message }); }
        finally { controller.current = undefined; }
      }
    } finally { running.current = false; }
  }
  function enqueue(files) {
    if (!sessionId) return; const chosen = Array.from(files || []);
    if (waiting.current.length + chosen.length > 100) { setError('每批最多 100 份日志，请先等待队列完成'); return; }
    const added = chosen.map(file => ({ id: crypto.randomUUID(), name: file.name, size: file.size, bytes: 0, sessionId, phase: '等待', file }));
    const activeIds = new Set([...waiting.current.map(item => item.id), ...queue.filter(item => ['上传中', '解析中'].includes(item.phase)).map(item => item.id)]); for (const id of retryFiles.current.keys()) if (!activeIds.has(id)) retryFiles.current.delete(id); for (const item of added) retryFiles.current.set(item.id, item.file);
    waiting.current.push(...added); setQueue(items => [...items.filter(i => ['等待', '上传中', '解析中'].includes(i.phase)), ...added.map(({ file, ...item }) => item)]); setError(''); void drain(); if (input.current) input.current.value = '';
  }
  function cancelQueue() { const pending = waiting.current.filter(item => item.sessionId === sessionId); waiting.current = waiting.current.filter(item => item.sessionId !== sessionId); for (const item of pending) updateItem(item.id, { phase: '已取消' }); if (controller.current?.sessionId === sessionId) controller.current.abort.abort(); }
  async function remove() {
    const action = confirm, target = sessionId; setConfirm(undefined); setBusy(true);
    try {
      const result = await request(target, 'delete', { body: action.body });
      if (currentSession.current !== target) return;
      setUndo(result.batchId); setNotice(`已移入回收区 ${result.removed} 份日志${result.errors.length ? `；${result.errors.length} 份未删除` : ''}`); setChecked(new Set()); setAll(undefined); setSelected(undefined); setTick(t => t + 1);
    } catch (e) { if (currentSession.current === target) setError(e.message); }
    finally { if (currentSession.current === target) setBusy(false); }
  }
  async function restore() {
    const target = sessionId, batchId = undo; setBusy(true);
    try { const result = await request(target, 'restore', { body: { batchId } }); if (currentSession.current === target) { setNotice(`已恢复 ${result.restored} 份日志${result.errors.length ? `；${result.errors.length} 份恢复失败，可再次撤销` : ''}`); if (!result.errors.length) setUndo(undefined); setTick(t => t + 1); } } catch (e) { if (currentSession.current === target) setError(e.message); } finally { if (currentSession.current === target) setBusy(false); }
  }
  async function showLegacy() { const target = sessionId; setLegacyOpen(true); try { const value = await request(target, 'unassigned'); if (currentSession.current === target) setLegacy(value); } catch (e) { if (currentSession.current === target) setError(e.message); } }
  async function assign(file) { const target = sessionId; setBusy(true); try { const value = await request(target, 'assign', { body: { id: file.id } }); if (currentSession.current === target) { setSelected(value); setTick(t => t + 1); setLegacy(v => ({ ...v, files: v.files.filter(f => f.id !== file.id), total: v.total - 1 })); setNotice('旧日志已归入当前会话，旧文件副本保留。'); } } catch (e) { if (currentSession.current === target) setError(e.message); } finally { if (currentSession.current === target) setBusy(false); } }
  function analyze(file, row, filters) { try { onDraft(logAnalysisPrompt(file, row, filters)); setNotice('已填入当前会话草稿，请检查或修改后发送。'); } catch (e) { setError(e.message); } }
  async function renameFile(event) { event.preventDefault(); const target = sessionId, value = renaming; setBusy(true); try { const file = await request(target, 'rename', { body: value }); if (currentSession.current === target) { setRenaming(undefined); if (selected?.id === file.id) setSelected(file); setTick(t => t + 1); } } catch (e) { if (currentSession.current === target) setError(e.message); } finally { if (currentSession.current === target) setBusy(false); } }
  const selectionCount = all ? all.count - all.exclude.length : checked.size;
  const sessionQueue = queue.filter(item => item.sessionId === sessionId), queueBusy = sessionQueue.some(item => ['等待', '上传中', '解析中'].includes(item.phase));
  if (!sessionId) return <div className="empty">打开一个会话后即可导入和管理日志。</div>;
  return <section className={'log-library' + (dragging ? ' dragging' : '')} aria-label="当前会话日志工作台" onDragEnter={e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); e.stopPropagation(); dragDepth.current++; setDragging(true); }} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } }} onDragLeave={e => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDrop={e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); e.stopPropagation(); dragDepth.current = 0; setDragging(false); enqueue(e.dataTransfer.files); }}>
    <div className="row spread library-heading"><div><strong>当前会话日志</strong><div className="muted">仅显示当前会话 · 可直接拖入文件 · 原文件保留</div></div><div className="row"><button onClick={() => setTick(t => t + 1)}>刷新</button><button className="primary" onClick={() => input.current?.click()}>导入日志</button></div></div>
    <input ref={input} hidden type="file" multiple accept=".txt,.log,.jsonl,.json" onChange={e => enqueue(e.target.files)}/>
    {dragging && <div className="drop-overlay">松开后复制到当前会话的暂存目录</div>}
    {!!sessionQueue.length && <details className="import-queue" open={queueBusy}><summary>导入队列 · {sessionQueue.filter(i => i.phase === '完成').length}/{sessionQueue.length} 完成</summary>{sessionQueue.map(item => <div key={item.id} className="queue-item"><strong>{item.name}</strong><span>{item.phase}{item.phase === '上传中' ? ` ${Math.round(item.bytes / item.size * 100)}%` : ''}</span>{item.error && <span className="error">{item.error}</span>}{item.phase === '失败' && retryFiles.current.has(item.id) && <button onClick={() => enqueue([retryFiles.current.get(item.id)])}>重试导入</button>}</div>)}{queueBusy && <button onClick={cancelQueue}>取消当前会话的导入</button>}</details>}
    {error && <p role="alert" className="notice error">{error}<button onClick={() => setError('')}>关闭</button></p>}
    {notice && <div role="status" className="notice row">{notice}{undo && <button disabled={busy} onClick={restore}>撤销删除</button>}<button onClick={() => setNotice('')}>关闭</button></div>}
    {confirm && <div className="notice" role="alertdialog" aria-label="确认删除日志"><strong>删除当前会话的 {confirm.count} 份暂存日志？</strong><p className="muted">{confirm.label}；移入回收区，可撤销。源文件、其他会话和测试报告保留。</p><div className="row"><button onClick={remove}>确认删除</button><button onClick={() => setConfirm(undefined)}>取消</button></div></div>}
    {renaming && <form className="notice row" onSubmit={renameFile}><label>日志名称 <input autoFocus aria-label="日志新名称" maxLength={256} value={renaming.name} onChange={e => setRenaming(value => ({ ...value, name: e.target.value }))}/></label><button disabled={busy}>确认改名</button><button type="button" onClick={() => setRenaming(undefined)}>取消</button></form>}
    <div className="library-split" ref={split} style={{ '--library-list-width': listWidth + '%' }}>
      <aside className={'library-files' + (selected ? ' has-selection' : '')}>
        <input className="search" aria-label="搜索当前会话日志文件" placeholder="搜索文件名" maxLength={256} value={query} onChange={e => setQuery(e.target.value)}/>
        <div className="row library-order"><select aria-label="日志文件来源" value={sourceKind} onChange={e => setSourceKind(e.target.value)}><option value="">所有来源</option><option value="import">导入</option><option value="realtime">实时保存</option><option value="legacy">旧日志</option></select><select aria-label="日志文件排序" value={sort} onChange={e => setSort(e.target.value)}><option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="name">按名称</option><option value="size">大文件优先</option></select></div>
        <div className="row library-selection"><label><input type="checkbox" aria-label="全选当前会话全部筛选文件" checked={!!all} disabled={!page?.total || busy} onChange={e => { setChecked(new Set()); if (!e.target.checked) { setAll(undefined); return; } const target = sessionId; setBusy(true); request(target, 'select', { body: { query: debounced, sourceKind } }).then(value => { if (currentSession.current === target) setAll({ ...value, exclude: [] }); }).catch(e => { if (currentSession.current === target) setError(e.message); }).finally(() => { if (currentSession.current === target) setBusy(false); }); }}/>{all ? `已选 ${selectionCount} 份（跨分页）` : `已选 ${selectionCount} 份`}</label><button disabled={!selectionCount || busy} onClick={() => setConfirm({ count: selectionCount, label: all ? '包括其它分页的筛选结果' : '仅选中的文件', body: all ? { token: all.token, exclude: all.exclude } : { ids: [...checked] } })}>删除选中</button></div>
        {!page ? <p>正在读取日志…</p> : !page.files.length ? <div className="empty">将日志拖到这里，或点击“导入日志”。<p className="muted">UTF-8 TXT / LOG / JSONL · 每份最多 32 MiB</p></div> : page.files.map(file => <div key={file.id} className={'library-file' + (selected?.id === file.id ? ' selected' : '')}>
          <input type="checkbox" aria-label={'选择 ' + file.name} checked={all ? all.ids.includes(file.id) && !all.exclude.includes(file.id) : checked.has(file.id)} disabled={busy} onChange={e => { if (all) setAll(value => ({ ...value, exclude: e.target.checked ? value.exclude.filter(id => id !== file.id) : [...value.exclude, file.id] })); else setChecked(values => { const next = new Set(values); e.target.checked ? next.add(file.id) : next.delete(file.id); return next; }); }}/>
          <button className="library-open" aria-label={'打开 ' + file.name} onClick={() => setSelected(file)}><strong>{file.name}</strong><span className="muted">{file.sourceKind === 'realtime' ? '实时保存' : file.sourceKind === 'legacy' ? '旧日志' : '导入'} · {file.count} 条 · {(file.size / 1048576).toFixed(2)} MiB</span><span className="muted">{new Date(file.createdAt).toLocaleString('zh-CN')}</span></button>
          <div className="row file-actions"><button onClick={() => analyze(file)}>AI 分析</button><button disabled={busy} onClick={() => setRenaming({ id: file.id, name: file.name })}>改名</button><button disabled={busy} onClick={() => setConfirm({ count: 1, label: file.name, body: { ids: [file.id] } })}>删除</button></div>
        </div>)}
        {page && <div className="row pager"><button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span className="muted">{page.total} 份</span><button disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset)}>下一页</button></div>}
        <details><summary>更多管理</summary><div className="row"><button disabled={!page || busy} onClick={() => { const target = sessionId; request(target, 'select', { body: {} }).then(value => { if (currentSession.current === target) setConfirm({ count: value.count, label: '当前会话全部暂存日志，不受搜索限制', body: { token: value.token } }); }).catch(e => { if (currentSession.current === target) setError(e.message); }); }}>清空当前会话</button><button onClick={showLegacy}>查看待归属旧日志</button></div><p className="muted">暂存副本和删除回收区保存在本机，当前没有自动清理期限。</p></details>
        {legacyOpen && <div className="box"><div className="row spread"><strong>待归属旧日志</strong><button onClick={() => setLegacyOpen(false)}>关闭</button></div><p className="muted">原全局库不自动归入任何会话；选择后复制并校验内容。</p>{!legacy ? '正在读取…' : !legacy.files.length ? '没有待归属日志' : legacy.files.map(file => <div key={file.id} className="row"><span>{file.name}</span><button disabled={busy} onClick={() => assign(file)}>归入当前会话</button></div>)}</div>}
        <button onClick={() => setTrashOpen(!trashOpen)}>回收区与空间占用</button>{trashOpen && <LogTrash key={sessionId} sessionId={sessionId} visible={visible} onChanged={() => { setTick(t => t + 1); setUndo(undefined); }} onClose={() => setTrashOpen(false)}/>}
      </aside>
      <div role="separator" aria-label="调整文件列表宽度" aria-orientation="vertical" tabIndex={0} className="library-resize" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const bounds = split.current.getBoundingClientRect(); setListWidth(Math.max(24, Math.min(55, (e.clientX - bounds.left) / bounds.width * 100))); }} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setListWidth(value => Math.max(24, Math.min(55, value + (e.key === 'ArrowLeft' ? -2 : 2)))); } }} onDoubleClick={() => setListWidth(32)}/>
      <main className={'library-preview' + (selected ? ' open' : '')}>
        {selected ? <><div className="row spread"><strong className="wrap">{selected.name}</strong><button onClick={() => setSelected(undefined)}>返回列表</button></div><div className="row"><span className="muted">{selected.count} 条 · 解析 {selected.parsed} / 原文 {selected.unparsed}</span><button onClick={() => analyze(selected)}>AI 分析文件</button><a href={libraryUrl(sessionId, 'source', { id: selected.id })} download={selected.name}>下载原文件</a></div><LogViewer key={sessionId + selected.id} url={libraryUrl(sessionId, 'logs', { id: selected.id })} exportUrl={libraryUrl(sessionId, 'export', { id: selected.id })} visible={visible} timeBasis="设备日志时间（缺年份时推定）" onAnalyze={(row, filters) => analyze(selected, row, filters)}/></> : <div className="empty">选择一份日志阅读、过滤或分析。<p className="muted">无需连接手机，阅读日志不会调用模型。</p></div>}
      </main>
    </div>
  </section>;
}
