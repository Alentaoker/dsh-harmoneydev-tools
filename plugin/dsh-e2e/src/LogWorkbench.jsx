import React, { useEffect, useRef, useState } from 'react';
import { LogViewer } from './LogViewer.jsx';
import { LogTrash } from './LogTrash.jsx';
import { libraryRequest as request, libraryUrl, importLogFile, logAnalysisPrompt, selectionAnalysisPrompt } from './log-client.mjs';

const workbenchCache = new Map();
export function LogWorkbench({ visible, sessionId, onDraft, openFileId }) {
  const [pageState, setPage] = useState(), [offset, setOffset] = useState(0), [selectedState, setSelected] = useState(), [query, setQuery] = useState(''), [debounced, setDebounced] = useState('');
  const page = pageState?.sessionId === sessionId ? pageState : undefined, selected = selectedState?.sessionId === sessionId ? selectedState : undefined;
  const [checked, setChecked] = useState(new Set()), [all, setAll] = useState(), [queue, setQueue] = useState([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [tick, setTick] = useState(0), [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false), [undo, setUndo] = useState(), [confirm, setConfirm] = useState(), [legacy, setLegacy] = useState(), [legacyOpen, setLegacyOpen] = useState(false), [listWidth, setListWidth] = useState(25);
  const [sourceKind, setSourceKind] = useState(''), [sort, setSort] = useState('newest'), [renaming, setRenaming] = useState(), [trashOpen, setTrashOpen] = useState(false);
  const [importEncoding, setImportEncoding] = useState('auto');
  const [toolPath, setToolPath] = useState(''), [readingFocus, setReadingFocus] = useState(false);
  const retryFiles = useRef(new Map());
  const input = useRef(), currentSession = useRef(sessionId), waiting = useRef([]), running = useRef(false), controller = useRef(), mounted = useRef(true), dragDepth = useRef(0), split = useRef();
  const dropRoot = useRef(), dropQueue = useRef(); dropQueue.current = enqueue;
  useEffect(() => {
    if (!visible) return; let claimed = false;
    const reset = () => { claimed = false; dragDepth.current = 0; setDragging(false); };
    const capture = event => {
      if (!event.dataTransfer?.types.includes('Files') || !dropRoot.current) return;
      const rect = dropRoot.current.getBoundingClientRect();
      if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { if (claimed) reset(); return; }
      event.preventDefault(); event.stopImmediatePropagation(); event.dataTransfer.dropEffect = 'copy';
      // DSH's document-level attachment overlay may already have been opened
      // before the pointer enters this pane. Claim this drop and reset that
      // overlay through its normal dragend lifecycle, without changing host code.
      if (!claimed) { window.dispatchEvent(new Event('dragend')); claimed = true; }
      setDragging(true);
      if (event.type === 'drop') {
        reset(); void dropQueue.current(event.dataTransfer.files);
      }
    };
    const leave = event => { const rect = dropRoot.current?.getBoundingClientRect(); if (claimed && (!rect || event.clientX <= rect.left || event.clientX >= rect.right || event.clientY <= rect.top || event.clientY >= rect.bottom)) reset(); };
    for (const type of ['dragenter', 'dragover', 'drop']) window.addEventListener(type, capture, true);
    window.addEventListener('dragleave', leave, true); window.addEventListener('dragend', reset);
    return () => { for (const type of ['dragenter', 'dragover', 'drop']) window.removeEventListener(type, capture, true); window.removeEventListener('dragleave', leave, true); window.removeEventListener('dragend', reset); };
  }, [visible, sessionId]);
  currentSession.current = sessionId;
  const viewSnapshot = useRef(); viewSnapshot.current = { sessionId, selected: selectedState, query, sourceKind, sort, offset, listWidth };
  useEffect(() => () => { if (viewSnapshot.current?.sessionId === sessionId) { workbenchCache.delete(sessionId); workbenchCache.set(sessionId, viewSnapshot.current); while (workbenchCache.size > 20) workbenchCache.delete(workbenchCache.keys().next().value); } }, [sessionId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; waiting.current = []; controller.current?.abort.abort(); }; }, []);
  useEffect(() => { const saved = workbenchCache.get(sessionId); setOffset(saved?.offset || 0); setPage(undefined); setSelected(saved?.selected); setChecked(new Set()); setAll(undefined); setQuery(saved?.query || ''); setDebounced(saved?.query || ''); setError(''); setNotice(''); setUndo(undefined); setConfirm(undefined); setBusy(false); setLegacy(undefined); setLegacyOpen(false); setSourceKind(saved?.sourceKind || ''); setSort(saved?.sort || 'newest'); setListWidth(saved?.listWidth || 25); setRenaming(undefined); setTrashOpen(false); setReadingFocus(false); }, [sessionId]);
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
  useEffect(() => { if (!visible || !sessionId) return; const abort = new AbortController(); request(sessionId, 'preferences', { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setToolPath(value.hilogtool || value.detectedHilogtool || ''); }).catch(() => {}); return () => abort.abort(); }, [visible, sessionId]);
  const updateItem = (id, patch) => { if (mounted.current) setQueue(items => items.map(item => item.id === id ? { ...item, ...patch } : item)); };
  async function drain() {
    if (running.current) return; running.current = true;
    try {
      while (waiting.current.length && mounted.current) {
        const item = waiting.current.shift(), abort = new AbortController(); controller.current = { abort, sessionId: item.sessionId };
        updateItem(item.id, { phase: '上传中' });
        try {
          const file = await importLogFile(item.file, item.sessionId, { signal: abort.signal, encoding: item.encoding, onProgress: (bytes, size, phase) => updateItem(item.id, { bytes, size, phase }) });
          updateItem(item.id, { phase: '完成' }); retryFiles.current.delete(item.id);
          if (mounted.current && currentSession.current === item.sessionId) { setSelected(file.files?.find(f => !f.isPackage) || file); setTick(t => t + 1); setOffset(0); }
        } catch (e) { updateItem(item.id, { phase: e.name === 'AbortError' ? '已取消' : '失败', error: e.name === 'AbortError' ? '' : e.message }); }
        finally { controller.current = undefined; if (mounted.current && currentSession.current === item.sessionId) setTick(t => t + 1); }
      }
    } finally { running.current = false; }
  }
  async function enqueue(files) {
    if (!sessionId) return; const target = sessionId, chosen = Array.from(files || []).sort((a, b) => Number(/^hilog_dict.*\.zip$/i.test(b.name)) - Number(/^hilog_dict.*\.zip$/i.test(a.name))); if (!chosen.length) return;
    if (waiting.current.length + chosen.length > 100) { setError('每批最多 100 份日志，请先等待队列完成'); return; }
    const added = chosen.map(file => ({ id: crypto.randomUUID(), name: file.name, size: file.size, bytes: 0, sessionId: target, phase: '等待', encoding: importEncoding, file }));
    const activeIds = new Set([...waiting.current.map(item => item.id), ...queue.filter(item => ['上传中', '解析中'].includes(item.phase)).map(item => item.id)]); for (const id of retryFiles.current.keys()) if (!activeIds.has(id)) retryFiles.current.delete(id); for (const item of added) retryFiles.current.set(item.id, item.file);
    waiting.current.push(...added); setQueue(items => [...items.filter(i => !['完成', '失败', '已取消'].includes(i.phase)), ...added.map(({ file, ...item }) => item)]); setError(''); void drain(); if (input.current) input.current.value = '';
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
  async function analyze(file, row, filters) {
    const target = sessionId; setBusy(true); setNotice('正在准备可读取的日志文件…');
    try { const prepared = await request(target, 'analysis', { body: { id: file.id } }); if (currentSession.current !== target) return; const body = prepared.files.find(f => f.id === file.id); onDraft(logAnalysisPrompt({ ...file, analysisPath: body?.path || body?.originalPath, manifestPath: prepared.manifestPath }, row, filters)); setNotice('已填入当前会话草稿，包含实际文件路径；请检查或修改后发送。'); }
    catch (e) { if (currentSession.current === target) setError(e.message); } finally { if (currentSession.current === target) setBusy(false); }
  }
  async function analyzeSelection() {
    const target = sessionId, ids = all ? all.ids.filter(id => !all.exclude.includes(id)) : [...checked];
    setBusy(true);
    try { const prepared = await request(target, 'analysis', { body: { ids } }); if (currentSession.current === target) { onDraft(selectionAnalysisPrompt(prepared)); setNotice('已将所选日志的分析草稿加入当前对话。'); } }
    catch (e) { if (currentSession.current === target) setError(e.message); } finally { if (currentSession.current === target) setBusy(false); }
  }
  async function retryPackage(file) { const target = sessionId; setBusy(true); try { const value = await request(target, 'retry-package', { body: { id: file.id, encoding: importEncoding } }); if (currentSession.current === target) { setSelected(value.files?.find(f => !f.isPackage) || value); setTick(t => t + 1); } } catch (e) { if (currentSession.current === target) setError(e.message); } finally { if (currentSession.current === target) setBusy(false); } }
  async function renameFile(event) { event.preventDefault(); const target = sessionId, value = renaming; setBusy(true); try { const file = await request(target, 'rename', { body: value }); if (currentSession.current === target) { setRenaming(undefined); if (selected?.id === file.id) setSelected(file); setTick(t => t + 1); } } catch (e) { if (currentSession.current === target) setError(e.message); } finally { if (currentSession.current === target) setBusy(false); } }
  const selectionCount = all ? all.count - all.exclude.length : checked.size;
  const sessionQueue = queue.filter(item => item.sessionId === sessionId), queueBusy = sessionQueue.some(item => !['完成', '失败', '已取消'].includes(item.phase));
  if (!sessionId) return <div className="empty">打开一个会话后即可导入和管理日志。</div>;
  return <section ref={dropRoot} className={'log-library' + (dragging ? ' dragging' : '') + (readingFocus && selected ? ' reading-focus' : '')} aria-label="当前会话日志工作台" onDragEnter={e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); e.stopPropagation(); dragDepth.current++; setDragging(true); }} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } }} onDragLeave={e => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDrop={e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); e.stopPropagation(); dragDepth.current = 0; setDragging(false); enqueue(e.dataTransfer.files); }}>
    <div className="row spread library-heading"><span className="muted">当前会话 · 按导入时间排序</span><div className="row"><button onClick={() => setTick(t => t + 1)} aria-label="刷新日志文件">刷新</button><select aria-label="导入日志编码" value={importEncoding} onChange={e => setImportEncoding(e.target.value)}><option value="auto">自动识别编码</option><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GB18030 / GBK</option></select><button className="primary" onClick={() => input.current?.click()}>导入日志</button></div></div>
    <input ref={input} hidden type="file" multiple accept=".txt,.log,.jsonl,.json,.gz,.zip,.rar" onChange={e => enqueue(e.target.files)}/>
    {dragging && <div className="drop-overlay">拖入一个或多个日志文件，自动识别文本、ZIP、GZ 和 RAR</div>}
    {!!sessionQueue.length && <details className="import-queue" open={queueBusy}><summary>导入队列 · {sessionQueue.filter(i => i.phase === '完成').length}/{sessionQueue.length} 完成</summary>{sessionQueue.map(item => <div key={item.id} className="queue-item"><strong>{item.name}</strong><span>{item.phase}{item.phase === '上传中' ? ` ${Math.round(item.bytes / item.size * 100)}%` : ''}</span>{item.error && <span className="error">{item.error}</span>}{item.phase === '失败' && retryFiles.current.has(item.id) && <button onClick={() => enqueue([retryFiles.current.get(item.id)])}>重试导入</button>}</div>)}{queueBusy && <button onClick={cancelQueue}>取消当前会话的导入</button>}</details>}
    {error && <p role="alert" className="notice error">{error}<button onClick={() => setError('')}>关闭</button></p>}
    {notice && <div role="status" className="notice row">{notice}{undo && <button disabled={busy} onClick={restore}>撤销删除</button>}<button onClick={() => setNotice('')}>关闭</button></div>}
    {confirm && <div className="notice" role="alertdialog" aria-label="确认删除日志"><strong>删除当前会话的 {confirm.count} 份暂存日志？</strong><p className="muted">{confirm.label}；移入回收区，可撤销。源文件、其他会话和测试报告保留。</p><div className="row"><button onClick={remove}>确认删除</button><button onClick={() => setConfirm(undefined)}>取消</button></div></div>}
    {renaming && <form className="notice row" onSubmit={renameFile}><label>日志名称 <input autoFocus aria-label="日志新名称" maxLength={256} value={renaming.name} onChange={e => setRenaming(value => ({ ...value, name: e.target.value }))}/></label><button disabled={busy}>确认改名</button><button type="button" onClick={() => setRenaming(undefined)}>取消</button></form>}
    <div className="library-split" ref={split} style={{ '--library-list-width': listWidth + '%' }}>
      <aside className={'library-files' + (selected ? ' has-selection' : '')}>
        <input className="search" aria-label="搜索当前会话日志文件" placeholder="搜索文件名" maxLength={256} value={query} onChange={e => setQuery(e.target.value)}/>
        <div className="row library-order"><select aria-label="日志文件来源" value={sourceKind} onChange={e => setSourceKind(e.target.value)}><option value="">所有来源</option><option value="import">导入</option><option value="realtime">实时保存</option><option value="legacy">旧日志</option></select><select aria-label="日志文件排序" value={sort} onChange={e => setSort(e.target.value)}><option value="newest">最新优先</option><option value="oldest">最早优先</option></select></div>
        <div className="row library-selection"><label><input type="checkbox" aria-label="全选当前会话全部筛选文件" checked={!!all} disabled={!page?.total || busy} onChange={e => { setChecked(new Set()); if (!e.target.checked) { setAll(undefined); return; } const target = sessionId; setBusy(true); request(target, 'select', { body: { query: debounced, sourceKind } }).then(value => { if (currentSession.current === target) setAll({ ...value, exclude: [] }); }).catch(e => { if (currentSession.current === target) setError(e.message); }).finally(() => { if (currentSession.current === target) setBusy(false); }); }}/>{all ? `已选 ${selectionCount} 份（跨分页）` : `已选 ${selectionCount} 份`}</label><button disabled={!selectionCount || busy} onClick={analyzeSelection}>分析选中</button><button disabled={!selectionCount || busy} onClick={() => setConfirm({ count: selectionCount, label: all ? '包括其它分页的筛选结果' : '仅选中的文件', body: all ? { token: all.token, exclude: all.exclude } : { ids: [...checked] } })}>删除选中</button></div>
        {!page ? <p>正在读取日志…</p> : !page.files.length ? <div className="empty">将日志拖到这里，或点击“导入日志”。<p className="muted">TXT / LOG / JSONL · 自动识别 UTF-8 / UTF-16 / GB18030 · 明文 256 MiB / 压缩包 512 MiB</p></div> : page.files.map(file => <div key={file.id} className={'library-file' + (selected?.id === file.id ? ' selected' : '')}>
          <input type="checkbox" aria-label={'选择 ' + file.name} checked={all ? all.ids.includes(file.id) && !all.exclude.includes(file.id) : checked.has(file.id)} disabled={busy} onChange={e => { if (all) setAll(value => ({ ...value, exclude: e.target.checked ? value.exclude.filter(id => id !== file.id) : [...value.exclude, file.id] })); else setChecked(values => { const next = new Set(values); e.target.checked ? next.add(file.id) : next.delete(file.id); return next; }); }}/>
          <button className="library-open" aria-label={'打开 ' + file.name} title={[file.name, file.origin?.relativePath, new Date(file.createdAt).toLocaleString('zh-CN')].filter(Boolean).join('\n')} onClick={() => setSelected(file)}><strong>{file.name}</strong><span className="muted">{file.sourceKind === 'realtime' ? '实时保存' : file.sourceKind === 'legacy' ? '旧日志' : '导入'} · {file.isPackage ? file.parsingStatus === 'dictionary' ? '字典' : '压缩文件 · ' + file.parsingStatus : file.count + ' 条'} · {(file.size / 1048576).toFixed(2)} MiB</span>{file.origin?.relativePath && <span className="muted file-relative">{file.origin.relativePath}</span>}</button>
          <div className="file-actions"><button disabled={busy} onClick={() => analyze(file)} aria-label={'AI 分析 ' + file.name}>AI</button><details className="library-item-menu"><summary aria-label={'文件操作 ' + file.name}>⋯</summary><div>{file.isPackage && file.parsingStatus !== 'dictionary' && <button disabled={busy} onClick={() => retryPackage(file)}>重新解析</button>}<button disabled={busy} onClick={() => setRenaming({ id: file.id, name: file.name })}>改名</button><button disabled={busy} onClick={() => setConfirm({ count: 1, label: file.name, body: { ids: [file.id] } })}>删除</button></div></details></div>
        </div>)}
        {page && <div className="row pager"><button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span className="muted">{page.total} 份</span><button disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset)}>下一页</button></div>}
        <details><summary>更多管理</summary><div className="row"><button disabled={!page || busy} onClick={() => { const target = sessionId; request(target, 'select', { body: {} }).then(value => { if (currentSession.current === target) setConfirm({ count: value.count, label: '当前会话全部暂存日志，不受搜索限制', body: { token: value.token } }); }).catch(e => { if (currentSession.current === target) setError(e.message); }); }}>清空当前会话</button><button onClick={showLegacy}>查看待归属旧日志</button></div><div className="row"><input aria-label="hilogtool 路径" value={toolPath} onChange={e => setToolPath(e.target.value)} placeholder="hilogtool.exe 的本机完整路径"/><button onClick={() => request(sessionId, 'preferences', { body: { hilogtool: toolPath.trim() } }).then(() => setNotice('工具路径已保存，可以重新解析压缩日志。')).catch(e => setError(e.message))}>保存解析工具路径</button></div><p className="muted">暂存副本和删除回收区保存在本机，当前没有自动清理期限。</p></details>
        {legacyOpen && <div className="box"><div className="row spread"><strong>待归属旧日志</strong><button onClick={() => setLegacyOpen(false)}>关闭</button></div><p className="muted">原全局库不自动归入任何会话；选择后复制并校验内容。</p>{!legacy ? '正在读取…' : !legacy.files.length ? '没有待归属日志' : legacy.files.map(file => <div key={file.id} className="row"><span>{file.name}</span><button disabled={busy} onClick={() => assign(file)}>归入当前会话</button></div>)}</div>}
        <button onClick={() => setTrashOpen(!trashOpen)}>回收区与空间占用</button>{trashOpen && <LogTrash key={sessionId} sessionId={sessionId} visible={visible} onChanged={() => { setTick(t => t + 1); setUndo(undefined); }} onClose={() => setTrashOpen(false)}/>}
      </aside>
      <div role="separator" aria-label="调整文件列表宽度" aria-orientation="vertical" tabIndex={0} className="library-resize" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const bounds = split.current.getBoundingClientRect(); setListWidth(Math.max(18, Math.min(45, (e.clientX - bounds.left) / bounds.width * 100))); }} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setListWidth(value => Math.max(18, Math.min(45, value + (e.key === 'ArrowLeft' ? -2 : 2)))); } }} onDoubleClick={() => setListWidth(25)}/>
      <main className={'library-preview' + (selected ? ' open' : '')}>
        {selected ? <><div className="library-document-heading"><div className="library-document-name"><strong title={selected.name}>{selected.name}</strong><span className="muted">{selected.isPackage ? '原始压缩文件' : selected.count + ' 条 · 解析 ' + selected.parsed + ' / 原文 ' + selected.unparsed + (selected.encoding ? ' · ' + selected.encoding.toUpperCase() : '')}</span></div><div className="row library-document-actions"><button disabled={busy} onClick={() => analyze(selected)}>AI 分析文件</button><button onClick={() => setReadingFocus(!readingFocus)}>{readingFocus ? '显示文件列表' : '专注阅读'}</button><details className="library-document-menu"><summary aria-label="当前文件更多操作">更多</summary><div><a href={libraryUrl(sessionId, 'source', { id: selected.id })} download={selected.name}>下载原文件</a><button onClick={() => { setSelected(undefined); setReadingFocus(false); }}>返回列表</button></div></details></div></div>{selected.isPackage ? <div className="box"><strong>原包已保留 · {selected.parsingStatus}</strong>{(selected.importWarnings || []).map((w, i) => <p key={i}>{w}</p>)}{selected.parsingStatus !== 'dictionary' && <button disabled={busy} onClick={() => retryPackage(selected)}>重新解析</button>}<p className="muted">识别出的日志显示在当前会话列表中。</p></div> : <LogViewer sessionId={sessionId} key={sessionId + selected.id} url={libraryUrl(sessionId, 'logs', { id: selected.id })} exportUrl={libraryUrl(sessionId, 'export', { id: selected.id })} visible={visible} timeBasis="设备日志时间（缺年份时推定）" onAnalyze={(row, filters) => analyze(selected, row, filters)}/>}</> : <div className="empty">选择一份日志阅读、过滤或分析。<p className="muted">无需连接手机，阅读日志不会调用模型。</p></div>}
      </main>
    </div>
  </section>;
}
