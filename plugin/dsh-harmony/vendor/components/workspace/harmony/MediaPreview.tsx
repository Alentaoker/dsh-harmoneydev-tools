"use client";
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MediaSessionContext } from '../../../../src/media-session';
import type { HarmonyMediaArtifact } from '@/lib/harmony/types';
import styles from '../HarmonyPanel.module.css';

type Tool = 'move' | 'rect' | 'arrow' | 'text' | 'redact';
type Mark = { tool: Tool; x: number; y: number; endX: number; endY: number; text: string; color: string };
export const mediaUrl = (item: HarmonyMediaArtifact) => `/api/harmony/media/${item.kind === 'recording' ? 'content' : 'preview'}?${new URLSearchParams({serial:item.serial,filename:item.filename})}`;
export function paintAnnotations(canvas: HTMLCanvasElement, image: CanvasImageSource, marks: Mark[]) {
  const ctx = canvas.getContext('2d'); if (!ctx) throw Error('图片绘制不可用');
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const unit = Math.max(3, canvas.width / 240);
  for (const mark of marks) {
    ctx.save(); ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = unit; ctx.lineCap = 'round';
    const dx = mark.endX-mark.x, dy = mark.endY-mark.y;
    if (mark.tool === 'rect') ctx.strokeRect(mark.x, mark.y, dx, dy);
    if (mark.tool === 'redact') { ctx.fillStyle = '#111'; ctx.fillRect(Math.min(mark.x,mark.endX),Math.min(mark.y,mark.endY),Math.max(2,Math.abs(dx)),Math.max(2,Math.abs(dy))); }
    if (mark.tool === 'arrow') {
      const angle = Math.atan2(dy,dx), head = unit*5;
      ctx.beginPath(); ctx.moveTo(mark.x,mark.y); ctx.lineTo(mark.endX,mark.endY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mark.endX,mark.endY); ctx.lineTo(mark.endX-head*Math.cos(angle-.5),mark.endY-head*Math.sin(angle-.5)); ctx.lineTo(mark.endX-head*Math.cos(angle+.5),mark.endY-head*Math.sin(angle+.5)); ctx.closePath(); ctx.fill();
    }
    if (mark.tool === 'text') { ctx.font = `600 ${Math.max(24,canvas.width/30)}px system-ui`; ctx.textBaseline='top'; ctx.fillText(mark.text.slice(0,200), mark.x, mark.y); }
    ctx.restore();
  }
}

export function MediaPreview({ item, onClose }: { item: HarmonyMediaArtifact; onClose: () => void }) {
  const { prepareAttachment } = useContext(MediaSessionContext);
  const canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null), dialog = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(), pending = useRef<Mark>(), pan = useRef<{x:number;y:number;left:number;top:number}>();
  const [source,setSource] = useState(item.kind === 'screenshot' ? mediaUrl(item) : ''), [ready,setReady] = useState(false);
  const [marks,setMarks] = useState<Mark[]>([]), [future,setFuture] = useState<Mark[]>([]), [tool,setTool] = useState<Tool>('move'), [color,setColor] = useState('#f34f5e'), [text,setText] = useState('问题位置');
  const [zoom,setZoom] = useState(1), [error,setError] = useState(''), [notice,setNotice] = useState(''), [busy,setBusy] = useState(false);
  const adding = useRef(false);
  const [videoReady,setVideoReady]=useState(false);
  const fit = () => { if (image.current && stage.current) setZoom(Math.min(1,(stage.current.clientWidth-40)/image.current.naturalWidth,(stage.current.clientHeight-40)/image.current.naturalHeight)); };
  const repaint = (extra?: Mark) => { if (canvas.current && image.current) paintAnnotations(canvas.current,image.current,extra ? [...marks,extra] : marks); };
  useEffect(() => {
    const previous=document.activeElement as HTMLElement; dialog.current?.focus();
    const oldOverflow=document.body.style.overflow; document.body.style.overflow='hidden';
    return () => { document.body.style.overflow=oldOverflow; previous?.focus?.(); };
  },[]);
  useEffect(() => {
    if (!source) return;
    let disposed=false; setReady(false); const loaded=new Image();
    loaded.onload=()=>{if(disposed || !canvas.current)return; image.current=loaded; canvas.current.width=loaded.naturalWidth;canvas.current.height=loaded.naturalHeight;setMarks([]);setFuture([]);setReady(true);dialog.current?.focus();fit();paintAnnotations(canvas.current,loaded,[]);};
    loaded.onerror=()=>{if(!disposed)setError('图片读取失败，请关闭后重试');}; loaded.src=source;
    return()=>{disposed=true;if(source.startsWith('blob:'))URL.revokeObjectURL(source);};
  },[source]);
  useEffect(()=>{repaint();},[marks,ready]);
  const undo=()=>{if(!marks.length)return;setFuture(values=>[marks[marks.length-1],...values]);setMarks(marks.slice(0,-1));};
  const redo=()=>{if(future.length){setMarks(current=>[...current,future[0]]);setFuture(current=>current.slice(1));}};
  const add=async()=>{
    if(adding.current || !ready || !canvas.current)return;
    adding.current=true;setBusy(true);setError('');setNotice('');
    try {
      if(!prepareAttachment)throw Error('当前宿主未提供会话附件能力');
      const attach=prepareAttachment();
      const output=document.createElement('canvas');output.width=canvas.current.width;output.height=canvas.current.height;
      paintAnnotations(output,image.current!,marks);
      const blob=await new Promise<Blob>((resolve,reject)=>output.toBlob(value=>value?resolve(value):reject(Error('图片生成失败')),'image/png'));
      await attach(new File([blob],item.filename.replace(/\.(png|mp4)$/i,marks.length?'-annotated.png':'.png'),{type:'image/png'}));
      setNotice(marks.length?'当前批注图片已加入对话，尚未发送':'图片已加入对话，尚未发送');
    } catch(e){setError(e instanceof Error?e.message:String(e));}finally{adding.current=false;setBusy(false);dialog.current?.focus();}
  };
  const captureFrame=()=>{
    try {if(!video.current?.videoWidth)throw Error('请先播放视频');const output=document.createElement('canvas');output.width=video.current.videoWidth;output.height=video.current.videoHeight;output.getContext('2d')!.drawImage(video.current,0,0);output.toBlob(blob=>{if(blob)setSource(URL.createObjectURL(blob));else setError('视频帧生成失败');},'image/png');}
    catch(e){setError(e instanceof Error?e.message:String(e));}
  };
  const point=(event: React.PointerEvent<HTMLCanvasElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(event.currentTarget.width,(event.clientX-rect.left)/rect.width*event.currentTarget.width)),y:Math.max(0,Math.min(event.currentTarget.height,(event.clientY-rect.top)/rect.height*event.currentTarget.height))};};
  return createPortal(<div className={styles.mediaOverlay} role="dialog" aria-modal="true" aria-label="截图预览与批注" ref={dialog} tabIndex={-1} onKeyDown={event=>{
    event.stopPropagation();
    if(event.key==='Tab') {const controls=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,video'));if(controls.length){const current=controls.indexOf(document.activeElement as HTMLElement);if(event.shiftKey && current<=0){event.preventDefault();controls.at(-1)!.focus();}else if(!event.shiftKey && current===controls.length-1){event.preventDefault();controls[0].focus();}}return;}
    if(event.isComposing)return;
    const key=event.key.toLowerCase();
    if(key==='escape'){event.preventDefault();onClose();return;}
    if((event.ctrlKey||event.metaKey) && key==='enter'){event.preventDefault();void add();return;}
    if((event.target as HTMLElement).closest('input,textarea,[contenteditable=true]'))return;
    if((event.ctrlKey||event.metaKey) && key==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
    if((event.ctrlKey||event.metaKey) && key==='y'){event.preventDefault();redo();return;}
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    const tools:Record<string,Tool>={v:'move',r:'rect',a:'arrow',t:'text',b:'redact'};
    if(tools[key]){event.preventDefault();setTool(tools[key]);}else if(['+','=','-','0','1'].includes(key)){event.preventDefault();key==='0'?fit():key==='1'?setZoom(1):setZoom(value=>Math.max(.05,Math.min(4,value*(key==='-'?.8:1.25))));}
  }}>
    <header className={styles.previewHeader}><div><strong>截图预览与批注</strong><small>{item.createdAt?new Date(item.createdAt).toLocaleString():''} · 原图保留</small></div><button onClick={onClose} title="关闭 Esc" aria-label="关闭预览">关闭 Esc</button></header>
    <div className={styles.annotationToolbar} role="toolbar" aria-label="批注工具">
      {([['move','移动 V'],['rect','矩形 R'],['arrow','箭头 A'],['text','文字 T'],['redact','打码 B']] as const).map(([id,label])=><button key={id} disabled={!ready} aria-pressed={tool===id} onClick={()=>setTool(id)}>{label}</button>)}
      <input aria-label="批注颜色" type="color" value={color} onChange={event=>setColor(event.target.value)}/>
      {tool==='text'&&<input aria-label="批注文字" maxLength={200} value={text} onChange={event=>setText(event.target.value)}/>}
      <button disabled={!marks.length} onClick={undo} title="Ctrl+Z">撤销</button><button disabled={!future.length} onClick={redo} title="Ctrl+Shift+Z / Ctrl+Y">重做</button>
      <button disabled={!ready} onClick={()=>setZoom(value=>Math.max(.05,value*.8))}>−</button><span>{Math.round(zoom*100)}%</span><button disabled={!ready} onClick={()=>setZoom(value=>Math.min(4,value*1.25))}>+</button><button disabled={!ready} onClick={fit}>适应 0</button><button disabled={!ready} onClick={()=>setZoom(1)}>原图 1</button>
    </div>
    <div className={styles.previewStage} ref={stage}>
      {!source&&<div className={styles.videoPreview}><video ref={video} controls preload="metadata" src={mediaUrl(item)} onLoadedData={()=>setVideoReady(true)} onError={()=>setError('录屏加载失败，请关闭后重试')}/><button disabled={!videoReady} onClick={captureFrame}>{videoReady?'截取当前帧并批注':'正在加载录屏…'}</button></div>}
      <canvas ref={canvas} hidden={!source} style={{display:source?'block':'none',width:image.current?image.current.naturalWidth*zoom:undefined,cursor:tool==='move'?'grab':'crosshair'}} onPointerDown={event=>{
        if(!ready||event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
        if(tool==='move'){pan.current={x:event.clientX,y:event.clientY,left:stage.current!.scrollLeft,top:stage.current!.scrollTop};return;}
        const p=point(event);pending.current={tool,...p,endX:p.x,endY:p.y,text,color};
      }} onPointerMove={event=>{
        if(pan.current){stage.current!.scrollLeft=pan.current.left+pan.current.x-event.clientX;stage.current!.scrollTop=pan.current.top+pan.current.y-event.clientY;return;}
        if(!pending.current)return;const p=point(event);pending.current={...pending.current,endX:p.x,endY:p.y};repaint(pending.current);
      }} onPointerUp={event=>{
        if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);pan.current=undefined;
        if(pending.current){const mark=pending.current;pending.current=undefined;if(marks.length>=200){setError('单张图片最多 200 个批注');repaint();return;}if(mark.tool==='text'||Math.abs(mark.endX-mark.x)+Math.abs(mark.endY-mark.y)>3){setMarks(current=>[...current,mark]);setFuture([]);}else repaint();}
      }} onPointerCancel={()=>{pan.current=undefined;pending.current=undefined;repaint();}}/>
    </div>
    <footer className={styles.previewFooter}><div>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<small>快捷键仅在预览内生效 · Ctrl+Enter 加入对话 · 批注另存为附件，原图不变</small></div><button disabled={!ready||busy} onClick={()=>void add()}>{busy?'正在加入…':'加入当前对话 Ctrl+Enter'}</button></footer>
  </div>,document.body);
}
