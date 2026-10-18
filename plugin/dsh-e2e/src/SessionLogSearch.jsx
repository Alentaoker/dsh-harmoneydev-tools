import React, { useEffect, useRef, useState } from 'react';
import { libraryRequest } from './log-client.mjs';
import { compilePattern, regexHelp } from './log-query.mjs';
import { useLogSearchHistory, LogSearchHistoryMenu } from './LogSearchHistory.jsx';
import { historyKeyAction, isComposingKey, nextCursor } from './log-search-menu.mjs';

export function SessionLogSearch({ sessionId, visible, onOpenSource }) {
  const [query, setQuery] = useState(''), [regex, setRegex] = useState(false), [caseSensitive, setCaseSensitive] = useState(false);
  const [criteria, setCriteria] = useState(), [offset, setOffset] = useState(0), [page, setPage] = useState(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [previous, setPrevious] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false), [cursor, setCursor] = useState(0), [selected, setSelected] = useState(false);
  const history = useLogSearchHistory('filter'), input = useRef(), cancellation = useRef();
  const search = (value = { query, regex, caseSensitive }) => {
    try {
      if (!value.query.trim()) throw Error('请输入要筛选的日志正文关键词');
      compilePattern(value.query, value);
      setCriteria({ ...value }); setOffset(0); setPrevious([]); setPage(undefined); setError(''); setHistoryOpen(false); setSelected(false);
      history.record(value.query, value.regex, value.caseSensitive);
    } catch (error) { setError(error.message); }
  };
  useEffect(() => {
    if (!visible || !criteria) { setBusy(false); return; }
    const controller = new AbortController(); cancellation.current = controller; setBusy(true); setError('');
    libraryRequest(sessionId, 'search', { params: { ...criteria, offset, limit: 100 }, signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { if (value.sessionId !== sessionId) throw Error('日志搜索会话不匹配'); setPage(value); }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); };
  }, [sessionId, visible, criteria, offset]);
  const pick = entry => { setQuery(entry.query); setRegex(entry.regex); setCaseSensitive(entry.caseSensitive); search(entry); };
  return <section className="session-log-search" aria-label="当前会话跨文件筛选" onKeyDown={event => {
    if (isComposingKey(event)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); input.current?.focus(); }
  }}>
    <h3>跨文件筛选</h3><p className="muted">搜索当前会话全部已解析日志的正文，包括压缩包解析出的文件；不受左侧文件名筛选和分页限制。</p>
    <form className="row" onSubmit={event => { event.preventDefault(); search(); }}>
      <div className="log-search-anchor" data-history-anchor="session-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHistoryOpen(false); }}>
        <input ref={input} aria-label="跨文件关键词" maxLength={256} value={query} placeholder="在当前会话全部日志中筛选…" onChange={event => { setQuery(event.target.value); setSelected(false); }}
          onFocus={() => { setHistoryOpen(true); setSelected(false); history.reload(); }}
          onBlur={event => { if (!event.currentTarget.closest('[data-history-anchor]').contains(event.relatedTarget)) setHistoryOpen(false); }}
          onKeyDown={event => {
            if (isComposingKey(event)) return;
            const action = historyKeyAction(event, { open: historyOpen, cursor, count: history.entries.length, selected });
            if (action === 'close') { event.preventDefault(); event.stopPropagation(); setHistoryOpen(false); }
            if (action === 'up' || action === 'down') { event.preventDefault(); setSelected(true); setCursor(value => nextCursor(value, action === 'up' ? -1 : 1, history.entries.length)); }
            if (action === 'apply') { event.preventDefault(); if (history.entries[cursor]) pick(history.entries[cursor]); }
          }}/>
        {history.available && <button type="button" aria-label="跨文件筛选历史" onClick={() => { setHistoryOpen(!historyOpen); setSelected(false); history.reload(); }}>历史</button>}
        {historyOpen && history.available && <LogSearchHistoryMenu entries={history.entries} cursor={cursor} onCursor={setCursor} onPick={pick} onRemove={history.remove} onClear={history.clear} onClose={() => setHistoryOpen(false)}/>}
      </div>
      <label className="check"><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)}/>区分大小写</label>
      <label className="check" title={regexHelp}><input type="checkbox" checked={regex} onChange={event => setRegex(event.target.checked)}/>正则</label>
      <button className="primary" type="submit">筛选当前会话</button>
      {busy && <button type="button" onClick={() => { cancellation.current?.abort(); setBusy(false); setError('搜索已取消；可修改关键词重新搜索。'); }}>取消搜索</button>}
    </form>
    {error && <p role="alert" className="error">{error}</p>}
    {busy && <p role="status">正在后台筛选全部文件…</p>}
    {page && <>
      <p role="status">{page.searchedFiles} 份日志 · {page.matchedFiles} 份匹配 · 共 {page.filteredTotal} 行匹配 · 本页 {page.entries.length} 行</p>
      {!!page.errors.length && <details><summary>有 {page.errors.length} 份文件读取失败，结果不完整</summary>{page.errors.map(file => <p key={file.id}>{file.name}：{file.error}</p>)}</details>}
      {!page.entries.length && <p className="empty">当前会话没有匹配结果。</p>}
      <div className="session-search-results" aria-busy={busy}>{page.entries.map((row, index) => <article key={row.fileId + ':' + row.sourceLine + ':' + index}>
        <button type="button" title="打开原文件及匹配行上下文" disabled={busy} onClick={() => onOpenSource(row.fileId, row.sourceLine)}>{row.fileName} · 第 {row.sourceLine} 行 ↗</button>
        <pre>{row.message}{row.messageTruncated ? '…（打开原文件查看完整行）' : ''}</pre>
      </article>)}</div>
      <div className="row"><button disabled={busy || !offset} onClick={() => { setOffset(0); setPrevious([]); }}>首页</button><button disabled={busy || !previous.length} onClick={() => { setOffset(previous.at(-1)); setPrevious(values => values.slice(0, -1)); }}>上一页</button><span>{offset + (page.entries.length ? 1 : 0)}–{offset + page.entries.length} / {page.filteredTotal}</span><button disabled={busy || page.nextOffset === null} onClick={() => { setPrevious(values => [...values, offset]); setOffset(page.nextOffset); }}>下一页</button></div>
    </>}
    {!criteria && <p className="empty">输入关键词后按 Enter，或点击“筛选当前会话”。</p>}
  </section>;
}
