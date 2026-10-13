import React, { useEffect, useRef, useState } from 'react';
import { LogViewer } from './LogViewer.jsx';

async function request(path, options = {}) {
  const response = await fetch('/api/dsh-e2e/log-library/' + path, options), value = await response.json();
  if (!response.ok || value.error) throw Error(value.error || '日志库请求失败'); return value;
}
const post = (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function LogWorkbench({ visible }) {
  const [page, setPage] = useState(), [offset, setOffset] = useState(0), [selected, setSelected] = useState(), [progress, setProgress] = useState(), [error, setError] = useState(''), [tick, setTick] = useState(0);
  const input = useRef(), upload = useRef();
  useEffect(() => {
    if (!visible) return; const controller = new AbortController(); let alive = true;
    request('list?offset=' + offset + '&limit=20', { signal: controller.signal }).then(value => { if (alive) setPage(value); }).catch(e => { if (alive && e.name !== 'AbortError') setError(e.message); });
    return () => { alive = false; controller.abort(); };
  }, [visible, offset, tick]);
  useEffect(() => () => { upload.current?.abort(); }, []);
  async function importFile(file) {
    if (!file || progress) return;
    if (!file.size || file.size > 32 * 1024 * 1024) { setError('请选择 1 字节～32 MiB 的 UTF-8 TXT / LOG / JSONL 文件；超限文件请先按时间切分。'); return; }
    const controller = new AbortController(); upload.current = controller; let id;
    setError(''); setProgress({ bytes: 0, size: file.size, phase: '上传中' });
    try {
      const started = await post('begin', { name: file.name, size: file.size }); id = started.id;
      let index = 0;
      for (let start = 0; start < file.size; start += 256 * 1024) {
        controller.signal.throwIfAborted(); const data = await file.slice(start, start + 256 * 1024).arrayBuffer();
        const result = await request('chunk?id=' + id + '&index=' + index++, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: data, signal: controller.signal });
        setProgress({ bytes: result.received, size: file.size, phase: '上传中' });
      }
      controller.signal.throwIfAborted(); setProgress({ bytes: file.size, size: file.size, phase: '正在识别和分批保存' });
      const value = await post('finish', { id }); setSelected(value); setTick(t => t + 1); setOffset(0);
    } catch (e) { if (id) await post('abort', { id }).catch(() => {}); setError(e.name === 'AbortError' ? '导入已取消' : e.message); }
    finally { setProgress(undefined); upload.current = undefined; if (input.current) input.current.value = ''; }
  }
  return <div className="log-library">
    <div className="row spread"><div><h3>本机日志工作台</h3><p className="muted">独立查看离线日志，无需手机、模型或测试任务；本机日志库可在各会话中查看。</p></div><button className="primary" disabled={!!progress} onClick={() => input.current?.click()}>导入日志</button></div>
    <input ref={input} style={{ display: 'none' }} type="file" accept=".txt,.log,.jsonl,.json" onChange={e => importFile(e.target.files?.[0])}/>
    <p className="muted">支持 UTF-8 HiLog TXT、DevEco 导出文本和 JSONL。每文件最多 32 MiB，分块读取；原始文件完整保留，结构化副本上限 64 MiB。其它文本按原文行保留。</p>
    {progress && <div role="status" className="notice">{progress.phase} · {Math.round(progress.bytes / progress.size * 100)}%<progress value={progress.bytes} max={progress.size}/>{progress.phase === '上传中' && <button onClick={() => upload.current?.abort()}>取消导入</button>}</div>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {selected ? <><div className="box"><div className="row spread"><strong>{selected.name}</strong><button onClick={() => setSelected(undefined)}>返回日志库</button></div><p className="muted">{selected.format} · {selected.count} 条 · 解析 {selected.parsed} / 原文 {selected.unparsed} · {new Date(selected.createdAt).toLocaleString('zh-CN')}</p><p className="code">日志文件 ID：{selected.id}</p><a href={'/api/dsh-e2e/log-library/source?id=' + selected.id} download={selected.name}>下载原始文件</a></div><LogViewer key={selected.id} url={'/api/dsh-e2e/log-library/logs?id=' + selected.id} exportUrl={'/api/dsh-e2e/log-library/export?id=' + selected.id} visible={visible} timeBasis="设备日志时间（缺年份时推定）"/></> : !page ? <p>正在读取日志库…</p> : <>
      {!page.files.length ? <div className="empty">尚未导入日志。选择文件即可开始查看与过滤。</div> : page.files.map(file => <button key={file.id} className="record" onClick={() => setSelected(file)}><strong>{file.name}</strong><div className="muted">{file.count} 条 · {(file.size / 1024 / 1024).toFixed(2)} MiB · {new Date(file.createdAt).toLocaleString('zh-CN')}</div></button>)}
      <div className="row pager"><button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>{page.total} 个本机文件</span><button disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset)}>下一页</button></div>
    </>}
  </div>;
}
