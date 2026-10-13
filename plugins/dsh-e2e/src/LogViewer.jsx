import React, { useEffect, useMemo, useRef, useState } from 'react';
import { compilePattern, regexHelp } from './log-query.mjs';

function Highlight({ text, pattern }) {
  text = String(text ?? ''); const ranges = pattern?.ranges(text) || [];
  if (!ranges.length) return text;
  const parts = []; let start = 0;
  for (const [from, until] of ranges) { parts.push(text.slice(start, from), <mark key={from}>{text.slice(from, until)}</mark>); start = until; }
  parts.push(text.slice(start)); return parts;
}

export function LogViewer({ url, exportUrl, visible = true, live = false, initialWindow, refreshKey = 0, timeBasis = '本机采集时间' }) {
  const [filters, setFilters] = useState({ query: '', tag: '', domain: '', pid: '', tid: '', level: '', regex: false, caseSensitive: false, from: initialWindow?.from || '', until: initialWindow?.until || '' });
  const [debounced, setDebounced] = useState(filters), [offset, setOffset] = useState(0), [history, setHistory] = useState([]), [page, setPage] = useState(), [error, setError] = useState('');
  const [findOpen, setFindOpen] = useState(false), [find, setFind] = useState(''), [findCase, setFindCase] = useState(false), [findRegex, setFindRegex] = useState(false), [cursor, setCursor] = useState(0);
  const [fullRow, setFullRow] = useState(), [exporting, setExporting] = useState(false), [exportError, setExportError] = useState('');
  const root = useRef(), findInput = useRef(), rows = useRef(new Map());
  useEffect(() => { const t = setTimeout(() => setDebounced(filters), 250); return () => clearTimeout(t); }, [filters]);
  useEffect(() => { setOffset(0); setHistory([]); }, [debounced, url]);
  useEffect(() => { if (initialWindow) setFilters(f => ({ ...f, from: initialWindow.from, until: initialWindow.until })); }, [initialWindow]);
  useEffect(() => {
    if (!visible) return; const controller = new AbortController(); let alive = true, timer;
    async function refresh() {
      try {
        const suffix = new URLSearchParams({ ...debounced, offset, limit: 100 });
        const response = await fetch(url + '&' + suffix, { signal: controller.signal }), value = await response.json();
        if (!response.ok || value.error) throw Error(value.error || '日志读取失败');
        if (alive) { setPage(value); setError(''); if (live) timer = setTimeout(refresh, 2000); }
      } catch (e) { if (alive && e.name !== 'AbortError') setError(e.message); }
    }
    setPage(undefined); refresh(); return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [url, visible, live, debounced, offset, refreshKey]);
  useEffect(() => {
    function key(event) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && root.current?.contains(document.activeElement)) { event.preventDefault(); setFindOpen(true); requestAnimationFrame(() => findInput.current?.focus()); } }
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  let pattern, findError;
  try { pattern = compilePattern(find, { regex: findRegex, caseSensitive: findCase }); } catch (e) { findError = e.message; }
  const matches = useMemo(() => {
    if (!pattern) return [];
    return (page?.entries || []).map((e, index) => ({ text: `${e.timestamp || ''} ${e.pid ?? ''} ${e.tid ?? ''} ${e.level} ${e.domain || ''} ${e.tag || ''} ${e.message || ''}`, index })).filter(e => pattern.test(e.text)).map(e => e.index);
  }, [page, find, findRegex, findCase]);
  useEffect(() => { setCursor(0); }, [find, findCase, findRegex, page]);
  useEffect(() => { setFullRow(undefined); }, [page]);
  async function readFull(index) {
    try { const response = await fetch(url + '&' + new URLSearchParams({ ...debounced, offset: offset + index, limit: 1, fullMessage: true })), value = await response.json(); if (!response.ok || value.error) throw Error(value.error || '完整行读取失败'); setFullRow(value.entries?.[0]); } catch (e) { setError(e.message); }
  }
  async function exportFiltered() {
    if (exporting) return; setExporting(true); setExportError(''); let destination;
    try {
      if (window.showSaveFilePicker) { const handle = await window.showSaveFilePicker({ suggestedName: 'filtered-logs.jsonl' }); destination = await handle.createWritable(); }
      const response = await fetch(exportUrl + '&' + new URLSearchParams(debounced)); if (!response.ok) throw Error((await response.json()).error || '日志导出失败');
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; if (destination) await destination.write(value); else { bytes += value.length; if (bytes > 8 * 1024 * 1024) throw Error('浏览器不支持流式保存，筛选结果超过 8 MiB；请收窄过滤，或从本机目录读取完整文件。'); chunks.push(value); } } }
      finally { await reader.cancel().catch(() => {}); }
      if (destination) { await destination.close(); destination = undefined; }
      else { const objectURL = URL.createObjectURL(new Blob(chunks, { type: 'application/x-ndjson' })), link = document.createElement('a'); link.href = objectURL; link.download = 'filtered-logs.jsonl'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectURL), 10000); }
    } catch (e) { await destination?.abort().catch(() => {}); if (e.name !== 'AbortError') setExportError(e.message); }
    finally { setExporting(false); }
  }
  function move(delta) { const next = (cursor + delta + matches.length) % matches.length; setCursor(next); rows.current.get(matches[next])?.scrollIntoView({ block: 'nearest' }); }
  const change = (key, value) => setFilters(f => ({ ...f, [key]: value }));
  return <section className="log-viewer" ref={root} tabIndex={0} aria-label="日志查看器，Ctrl+F 查找本页">
    <div className="log-filter-grid">
      <input aria-label="日志关键词" placeholder="过滤关键词" value={filters.query} onChange={e => change('query', e.target.value)} maxLength={256}/>
      <select aria-label="最低日志级别" value={filters.level} onChange={e => change('level', e.target.value)}><option value="">全部级别</option>{['debug', 'info', 'warn', 'error', 'fatal'].map(l => <option key={l} value={l}>{l} 及以上</option>)}</select>
      {['tag', 'domain', 'pid', 'tid'].map(key => <input key={key} aria-label={'过滤 ' + key.toUpperCase()} placeholder={key.toUpperCase()} value={filters[key]} onChange={e => change(key, e.target.value)} maxLength={256}/>)}
    </div>
    <div className="row"><label className="check"><input type="checkbox" checked={filters.caseSensitive} onChange={e => change('caseSensitive', e.target.checked)}/>Aa 区分大小写</label><label className="check" title={regexHelp}><input type="checkbox" checked={filters.regex} onChange={e => change('regex', e.target.checked)}/>.* 正则过滤</label><button onClick={() => { setFindOpen(true); requestAnimationFrame(() => findInput.current?.focus()); }}>查找 · Ctrl+F</button><button onClick={() => setFilters({ query: '', tag: '', domain: '', pid: '', tid: '', level: '', regex: false, caseSensitive: false, from: '', until: '' })}>清除过滤</button></div>
    <details><summary>时间范围 · {timeBasis}</summary><div className="log-filter-grid">{['from', 'until'].map(key => <label key={key}>{key === 'from' ? '开始' : '结束'}<input aria-label={key === 'from' ? '日志开始时间' : '日志结束时间'} type="datetime-local" value={filters[key] ? (() => { const date = new Date(filters[key]); return Number.isFinite(+date) ? new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19) : ''; })() : ''} onChange={e => change(key, e.target.value ? new Date(e.target.value).toISOString() : '')}/></label>)}</div></details>
    {filters.regex && <p className="muted">{regexHelp}</p>}
    {exportUrl && <div className="row"><button disabled={exporting} onClick={exportFiltered}>{exporting ? '正在导出…' : '导出全部筛选结果'}</button><span className="muted">包含分页以外的匹配日志</span></div>}{exportError && <p role="alert" className="notice error">{exportError}</p>}
    {findOpen && <div className="log-find" role="search"><div className="row"><input ref={findInput} aria-label="查找本页日志" placeholder="本页查找，不改变过滤结果" value={find} maxLength={256} onChange={e => setFind(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && matches.length) { e.preventDefault(); move(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { setFindOpen(false); setFind(''); } }}/><button disabled={!matches.length} aria-label="上一个匹配行" onClick={() => move(-1)}>↑</button><button disabled={!matches.length} aria-label="下一个匹配行" onClick={() => move(1)}>↓</button><button aria-label="关闭查找" onClick={() => { setFindOpen(false); setFind(''); }}>×</button></div><div className="row"><label className="check"><input type="checkbox" checked={findCase} onChange={e => setFindCase(e.target.checked)}/>Aa</label><label className="check"><input type="checkbox" checked={findRegex} onChange={e => setFindRegex(e.target.checked)}/>.*</label><span className="muted">{matches.length ? cursor + 1 : 0}/{matches.length} 个匹配行 · 仅当前页；搜索全部日志请用过滤</span></div>{findError && <p role="alert" className="error">{findError}</p>}</div>}
    {error ? <p role="alert" className="notice error">{error}</p> : !page ? <p role="status">正在读取日志…</p> : <>
      <p className="muted">磁盘/记录 {page.total} 条 · 符合过滤 {page.filteredTotal} 条 · 本页 {page.entries.length ? offset + 1 : 0}–{offset + page.entries.length} · 每页最多 100 条 / 24 KiB</p>
      {(page.logCollection?.warnings || []).map((warning, i) => <p className="muted" key={i}>{warning}</p>)}
      <div className="log-table-scroll"><table className="log-table"><thead><tr>{['时间', 'PID:TID', '级别', 'DOMAIN', 'TAG', '消息'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{page.entries.map((e, index) => <tr key={index} ref={node => node ? rows.current.set(index, node) : rows.current.delete(index)} className={'log-' + e.level + (find && matches[cursor] === index ? ' find-current' : '')}><td><Highlight text={e.timestamp || e.capturedAt} pattern={pattern}/></td><td><Highlight text={`${e.pid ?? '—'}:${e.tid ?? '—'}`} pattern={pattern}/></td><td><Highlight text={e.level} pattern={pattern}/></td><td><Highlight text={e.domain || '—'} pattern={pattern}/></td><td title={e.process}><Highlight text={e.tag || '—'} pattern={pattern}/></td><td><div className="log-message-preview"><Highlight text={e.message} pattern={pattern}/></div><div className="row muted"><button className="log-detail-button" onClick={() => readFull(index)}>查看详情</button>{e.messageTruncated && <span>预览截断 · 共 {e.messageLength} 字符</span>}</div></td></tr>)}</tbody></table>{!page.entries.length && <div className="empty">没有符合过滤的日志。请检查时间范围及采集状态。</div>}</div>
      {fullRow && <div className="box"><div className="row spread"><strong>{fullRow.tag} · 单条原记录</strong><button onClick={() => setFullRow(undefined)}>关闭</button></div><pre>{fullRow.message}</pre>{fullRow.messageTruncated && <p className="muted">单条读取仍限制 8192 字符，更长内容请查看原始文件。</p>}</div>}
      <div className="row pager"><button disabled={!offset} onClick={() => { setOffset(0); setHistory([]); }}>首页</button><button disabled={!history.length} onClick={() => { setOffset(history.at(-1)); setHistory(h => h.slice(0, -1)); }}>上一页</button><button disabled={page.nextOffset === null} onClick={() => { setHistory(h => [...h.slice(-999), offset]); setOffset(page.nextOffset); }}>下一页</button></div>
    </>}
  </section>;
}
