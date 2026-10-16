"use client";
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { HarmonyMediaArtifact } from '@/lib/harmony/types';
import { MediaSessionContext } from '../../../../src/media-session';
import { MediaPreview, mediaUrl } from './MediaPreview';
import styles from '../HarmonyPanel.module.css';

export function MediaHistory({ serial, refreshKey, chinese }: { serial: string; refreshKey?: string; chinese: boolean }) {
  const [artifacts,setArtifacts]=useState<HarmonyMediaArtifact[]>([]),[truncated,setTruncated]=useState(false),[legacy,setLegacy]=useState(false);
  const [filter,setFilter]=useState('all'),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState<HarmonyMediaArtifact>();
  const {prepareAttachment}=useContext(MediaSessionContext);
  const loadGeneration=useRef(0);
  const adding=useRef(false),currentSerial=useRef(serial);currentSerial.current=serial;
  const load=useCallback(async(signal?:AbortSignal)=>{
    const generation=++loadGeneration.current;
    const response=await fetch(`/api/harmony/media/history?${new URLSearchParams({serial,scope:legacy?'legacy':'manual'})}`,{cache:'no-store',signal});
    const data=await response.json();if(!response.ok)throw Error(data.error?.message||data.error||'截图历史读取失败');
    if(!Array.isArray(data.artifacts))throw Error('截图历史格式不匹配，请更新并重启插件');
    if(!signal?.aborted && generation===loadGeneration.current && currentSerial.current===serial){setArtifacts(data.artifacts);setTruncated(!!data.truncated);setError('');}
  },[serial,legacy]);
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
  return <section className={styles.captureLibrary} aria-label="手动截图与录屏">
    <div className={styles.captureLibraryHeading}><div><strong>截图与录屏</strong><small>{legacy?'来源不明的旧记录，保留但不认定为手动':'手动保存 · 跨会话保留 · 按时间排序'}</small></div><button onClick={()=>void load().catch(e=>setError(e.message))}>刷新</button></div>
    <div className={styles.captureFilters}><select aria-label="媒体类型" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部</option><option value="screenshot">截图</option><option value="recording">录屏</option></select><label><input type="checkbox" checked={legacy} onChange={e=>setLegacy(e.target.checked)}/>查看来源不明的旧记录</label></div>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {truncated&&<small>最多展示最近 40 份符合范围的记录。</small>}
    {!artifacts.filter(item=>filter==='all'||item.kind===filter).length&&<p className={styles.captureEmpty}>{legacy?'没有可展示的旧记录':'点击设备下方“截图”或“录屏”即可保存。AI 与测试截图不混入此处。'}</p>}
    <div className={styles.captureGrid}>{artifacts.filter(item=>filter==='all'||item.kind===filter).map(item=><article key={item.path} className={styles.captureCard}>
      <button className={styles.captureThumb} aria-label={'预览 '+item.filename} onClick={()=>setPreview(item)}>{item.kind==='screenshot'?<img loading="lazy" src={mediaUrl(item)} alt="点击预览并批注截图"/>:<span>录屏 · 点击播放</span>}</button>
      <div className={styles.captureCardBody}><strong>{item.kind==='screenshot'?'截图':'录屏'} · {new Date(item.createdAt).toLocaleString()}</strong><small>{item.source==='manual'?'手动保存':'来源未知'}{item.width?` · ${item.width}×${item.height}`:''}</small>
        <div className={styles.captureCardActions}><button onClick={()=>setPreview(item)}>预览{item.kind==='screenshot'?'与批注':''}</button><button disabled={busy} onClick={()=>void add(item)}>{item.kind==='recording'?'选帧加入对话':'加入对话'}</button></div>
        <details><summary>文件信息</summary><small>{item.filename} · {(item.size/1024).toFixed(1)} KiB</small><code>{item.path}</code></details>
      </div>
    </article>)}</div>
    {preview&&<MediaPreview item={preview} onClose={()=>setPreview(undefined)}/>}
  </section>;
}
