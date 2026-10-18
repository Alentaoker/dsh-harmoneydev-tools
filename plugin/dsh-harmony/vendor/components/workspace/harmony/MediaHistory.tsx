"use client";
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { HarmonyMediaArtifact } from '@/lib/harmony/types';
import { MediaSessionContext } from '../../../../src/media-session';
import { MediaPreview, mediaUrl } from './MediaPreview';
import styles from '../HarmonyPanel.module.css';

export function MediaHistory({ serial, refreshKey, chinese }: { serial: string; refreshKey?: string; chinese: boolean }) {
  const [artifacts,setArtifacts]=useState<HarmonyMediaArtifact[]>([]),[truncated,setTruncated]=useState(false),[legacy,setLegacy]=useState(false);
  const [filter,setFilter]=useState('all'),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState<HarmonyMediaArtifact>();
  const [limit,setLimit]=useState(40),[selected,setSelected]=useState<Set<string>>(new Set()),[confirm,setConfirm]=useState<HarmonyMediaArtifact[]>(),[deleting,setDeleting]=useState(false);
  const deletePending=useRef(false);
  const {prepareAttachment}=useContext(MediaSessionContext);
  const loadGeneration=useRef(0);
  const adding=useRef(false),currentSerial=useRef(serial);currentSerial.current=serial;
  const load=useCallback(async(signal?:AbortSignal)=>{
    const generation=++loadGeneration.current;
    const response=await fetch(`/api/harmony/media/history?${new URLSearchParams({serial,scope:legacy?'legacy':'manual',limit:String(limit)})}`,{cache:'no-store',signal});
    const data=await response.json();if(!response.ok)throw Error(data.error?.message||data.error||'截图历史读取失败');
    if(!Array.isArray(data.artifacts))throw Error('截图历史格式不匹配，请更新并重启插件');
    if(!signal?.aborted && generation===loadGeneration.current && currentSerial.current===serial){setArtifacts(data.artifacts);setTruncated(!!data.truncated);setError('');}
  },[serial,legacy,limit]);
  useEffect(()=>{setSelected(new Set());setConfirm(undefined);setLimit(40);},[serial,legacy,filter]);
  useEffect(()=>{const controller=new AbortController();setArtifacts([]);setPreview(undefined);setError('');setNotice('');void load(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[load,refreshKey]);
  const add=async(item:HarmonyMediaArtifact)=>{
    if(item.kind==='recording'){setPreview(item);return;}
    if(adding.current)return;adding.current=true;setBusy(true);setError('');setNotice('');
    try {
      if(!prepareAttachment)throw Error('请先打开目标会话');const attach=prepareAttachment();
      const response=await fetch(mediaUrl(item));if(!response.ok)throw Error('图片读取失败');
      const blob=await response.blob();await attach(new File([blob],item.filename,{type:'image/png'}));
      if(currentSerial.current===item.serial)setNotice('图片已加入发起时的当前对话，尚未发送');
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{adding.current=false;setBusy(false);}
  };
  const visible=artifacts.filter(item=>filter==='all'||item.kind===filter), chosen=visible.filter(item=>selected.has(item.filename));
  const toggle=(filename:string)=>setSelected(current=>{const next=new Set(current);next.has(filename)?next.delete(filename):next.add(filename);return next;});
  const remove=async()=>{
    if(deletePending.current||!confirm?.length)return;
    const items=confirm,targetSerial=serial;deletePending.current=true;setDeleting(true);setError('');
    try{
      const response=await fetch('/api/harmony/media/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serial,scope:legacy?'legacy':'manual',items:items.map(({kind,filename})=>({kind,filename}))})});
      const data=await response.json();if(!response.ok)throw Error(data.error?.message||data.error||'删除失败');
      if(currentSerial.current!==targetSerial)return;
      const removed=new Set<string>(data.deleted);setArtifacts(current=>current.filter(item=>!removed.has(item.filename)));setSelected(current=>new Set([...current].filter(name=>!removed.has(name))));
      if(preview&&removed.has(preview.filename))setPreview(undefined);
      setConfirm(undefined);setNotice(`已删除 ${data.deleted.length} 项，释放 ${(data.freedBytes/1024/1024).toFixed(2)} MiB 磁盘空间。`);
      if(data.errors?.length)setError(data.errors.map((item:{filename:string;error:string})=>`${item.filename}：${item.error}`).join('；'));
    }catch(e){if(currentSerial.current===targetSerial)setError(e instanceof Error?e.message:String(e));}finally{deletePending.current=false;setDeleting(false);}
  };
  return <section className={styles.captureLibrary} aria-label="手动截图与录屏">
    <div className={styles.captureLibraryHeading}><div><strong>截图与录屏</strong><small>{legacy?'来源不明的旧记录，保留但不认定为手动':'手动保存 · 跨会话保留 · 按时间排序'}</small></div><button onClick={()=>void load().catch(e=>setError(e.message))}>刷新</button></div>
    <div className={styles.captureFilters}><select disabled={deleting} aria-label="媒体类型" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部</option><option value="screenshot">截图</option><option value="recording">录屏</option></select><label><input disabled={deleting} type="checkbox" checked={legacy} onChange={e=>setLegacy(e.target.checked)}/>查看来源不明的旧记录</label></div>
    <div className={styles.captureFilters}><label><input type="checkbox" disabled={deleting||!visible.length} checked={!!visible.length&&chosen.length===visible.length} ref={node=>{if(node)node.indeterminate=chosen.length>0&&chosen.length<visible.length;}} onChange={e=>setSelected(e.target.checked?new Set(visible.map(item=>item.filename)):new Set())}/>全选当前列表（{visible.length}）</label><span>已选 {chosen.length} 项</span><button disabled={!chosen.length||deleting} onClick={()=>setConfirm(chosen)}>删除所选</button>{chosen.length>0&&<button disabled={deleting} onClick={()=>setSelected(new Set())}>取消选择</button>}</div>
    {confirm&&<div className={styles.captureDeleteConfirm} role="alertdialog" aria-label="确认删除截图录屏"><strong>删除这 {confirm.length} 项截图 / 录屏？</strong><p>将从本机媒体目录永久删除，释放约 {(confirm.reduce((sum,item)=>sum+item.size,0)/1024/1024).toFixed(2)} MiB。已加入对话的附件保留。</p><button disabled={deleting} onClick={()=>void remove()}>{deleting?'正在删除…':'确认删除'}</button><button disabled={deleting} onClick={()=>setConfirm(undefined)}>取消</button></div>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {truncated&&<small>当前加载最近 {limit} 份记录。{limit<1000?<button disabled={deleting} onClick={()=>setLimit(value=>Math.min(1000,value+40))}>加载更多</button>:'删除已选记录后刷新，可继续清理更早记录。'}</small>}
    {!artifacts.filter(item=>filter==='all'||item.kind===filter).length&&<p className={styles.captureEmpty}>{legacy?'没有可展示的旧记录':'点击设备下方“截图”或“录屏”即可保存。AI 与测试截图不混入此处。'}</p>}
    <div className={styles.captureGrid}>{visible.map(item=><article key={item.path} className={styles.captureCard}>
      <label className={styles.captureSelection}><input type="checkbox" disabled={deleting} aria-label={'选择 '+item.filename} checked={selected.has(item.filename)} onChange={()=>toggle(item.filename)}/></label>
      <button className={styles.captureThumb} aria-label={'预览 '+item.filename} onClick={()=>setPreview(item)}>{item.kind==='screenshot'?<img loading="lazy" src={mediaUrl(item)} alt="点击预览并批注截图"/>:<span>录屏 · 点击播放</span>}</button>
      <div className={styles.captureCardBody}><strong>{item.kind==='screenshot'?'截图':'录屏'} · {new Date(item.createdAt).toLocaleString()}</strong><small>{item.source==='manual'?'手动保存':'来源未知'}{item.width?` · ${item.width}×${item.height}`:''}</small>
        <div className={styles.captureCardActions}><button onClick={()=>setPreview(item)}>预览{item.kind==='screenshot'?'与批注':''}</button><button disabled={busy||deleting} onClick={()=>void add(item)}>{item.kind==='recording'?'选帧加入对话':'加入对话'}</button><button disabled={deleting} onClick={()=>setConfirm([item])}>删除</button></div>
        <details><summary>文件信息</summary><small>{item.filename} · {(item.size/1024).toFixed(1)} KiB</small><code>{item.path}</code></details>
      </div>
    </article>)}</div>
    {preview&&<MediaPreview item={preview} onClose={()=>setPreview(undefined)} onAdded={()=>setNotice('批注图片已加入对话，预览已关闭；可继续在输入框补充说明。')}/>}
  </section>;
}
