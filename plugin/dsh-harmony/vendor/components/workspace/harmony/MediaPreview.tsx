"use client";
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MediaSessionContext } from '../../../../src/media-session';
import type { HarmonyMediaArtifact } from '@/lib/harmony/types';
import styles from '../HarmonyPanel.module.css';
import { editTextMark, textFontSize, textMarkAt, type AnnotationMark as Mark, type AnnotationTool as Tool } from './media-annotations';
import { isComposingKey } from '@dsh-log-search-menu';

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
    if (mark.tool === 'text') { ctx.font = `600 ${textFontSize(canvas.width)}px system-ui`; ctx.textBaseline='top'; ctx.fillText(mark.text.slice(0,200), mark.x, mark.y); }
    ctx.restore();
  }
}

export function MediaPreview({ item, onClose, onAdded }: { item: HarmonyMediaArtifact; onClose: () => void; onAdded?: () => void }) {
  const { prepareAttachment } = useContext(MediaSessionContext);
  const canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null), dialog = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(), pending = useRef<Mark>(), pan = useRef<{x:number;y:number;left:number;top:number}>();
  const skipFocusRestore = useRef(false);
  const [source,setSource] = useState(item.kind === 'screenshot' ? mediaUrl(item) : ''), [ready,setReady] = useState(false);
  const [marks,setMarks] = useState<Mark[]>([]), [future,setFuture] = useState<Mark[][]>([]), [tool,setTool] = useState<Tool>('move'), [color,setColor] = useState('#f34f5e');
  type TextEdit = { index: number | null; mark: Mark };
  const [editor,setEditor] = useState<TextEdit>(), editorRef = useRef<TextEdit>(), textInput = useRef<HTMLInputElement>(null), marksRef = useRef<Mark[]>([]), past = useRef<Mark[][]>([]);
  marksRef.current=marks;
  const [zoom,setZoom] = useState(1), [error,setError] = useState(''), [notice,setNotice] = useState(''), [busy,setBusy] = useState(false);
  const adding = useRef(false);
  const [videoReady,setVideoReady]=useState(false);
  const fit = () => { if (image.current && stage.current) setZoom(Math.min(1,(stage.current.clientWidth-40)/image.current.naturalWidth,(stage.current.clientHeight-40)/image.current.naturalHeight)); };
  const repaint = (extra?: Mark) => { if (canvas.current && image.current) { const visible=marks.filter((_,index)=>editor?.index!==index); paintAnnotations(canvas.current,image.current,extra ? [...visible,extra] : visible); } };
  const writeMarks=(next:Mark[])=>{if(next===marksRef.current)return;past.current=[...past.current.slice(-99),marksRef.current];marksRef.current=next;setMarks(next);setFuture([]);};
  const commitText=()=>{
    const current=editorRef.current;if(!current)return marksRef.current;
    try{writeMarks(editTextMark(marksRef.current,current.index,current.mark));}catch(error){setError((error as Error).message);return null;}
    editorRef.current=undefined;setEditor(undefined);
    return marksRef.current;
  };
  const startText=(next:TextEdit)=>{editorRef.current=next;setEditor(next);};
  useEffect(()=>{if(editor){textInput.current?.focus();textInput.current?.select();}},[editor?.index,editor?.mark.x,editor?.mark.y]);
  useEffect(() => {
    const previous=document.activeElement as HTMLElement; dialog.current?.focus();
    const oldOverflow=document.body.style.overflow; document.body.style.overflow='hidden';
    // A successful "add to conversation" focuses the target input itself, so the
    // dialog must not pull focus back to the element that opened it.
    return () => { document.body.style.overflow=oldOverflow; if(!skipFocusRestore.current) previous?.focus?.(); };
  },[]);
  useEffect(() => {
    if (!source) return;
    let disposed=false; setReady(false); const loaded=new Image();
    loaded.onload=()=>{if(disposed || !canvas.current)return; image.current=loaded; canvas.current.width=loaded.naturalWidth;canvas.current.height=loaded.naturalHeight;marksRef.current=[];past.current=[];editorRef.current=undefined;setEditor(undefined);setMarks([]);setFuture([]);setReady(true);dialog.current?.focus();fit();paintAnnotations(canvas.current,loaded,[]);};
    loaded.onerror=()=>{if(!disposed)setError('图片读取失败，请关闭后重试');}; loaded.src=source;
    return()=>{disposed=true;if(source.startsWith('blob:'))URL.revokeObjectURL(source);};
  },[source]);
  useEffect(()=>{repaint();},[marks,ready,editor]);
  const undo=()=>{commitText();const previous=past.current.pop();if(!previous)return;const current=marksRef.current;setFuture(values=>[current,...values]);marksRef.current=previous;setMarks(previous);};
  const redo=()=>{if(editorRef.current){commitText();return;}if(future.length){past.current.push(marksRef.current);marksRef.current=future[0];setMarks(future[0]);setFuture(current=>current.slice(1));}};
  const add=async()=>{
    if(adding.current || !ready || !canvas.current)return;
    const outputMarks=commitText();if(!outputMarks)return;
    adding.current=true;setBusy(true);setError('');setNotice('');
    try {
      if(!prepareAttachment)throw Error('当前宿主未提供会话附件能力');
      // The destination session is fixed here, before any asynchronous render,
      // so a session switch during annotation cannot receive the image.
      const attach=prepareAttachment();
      const output=document.createElement('canvas');output.width=canvas.current.width;output.height=canvas.current.height;
      paintAnnotations(output,image.current!,outputMarks);
      const blob=await new Promise<Blob>((resolve,reject)=>output.toBlob(value=>value?resolve(value):reject(Error('图片生成失败')),'image/png'));
      await attach(new File([blob],item.filename.replace(/\.(png|mp4)$/i,outputMarks.length?'-annotated.png':'.png'),{type:'image/png'}));
      setNotice(marks.length?'当前批注图片已加入对话，尚未发送':'图片已加入对话，尚未发送');
      // The attachment is prepared and focused. Close the preview so the person
      // can continue typing in the conversation.
      skipFocusRestore.current=true;
      onAdded?.();
      onClose();
    } catch(e){setError(e instanceof Error?e.message:String(e));}finally{adding.current=false;setBusy(false);if(!skipFocusRestore.current)dialog.current?.focus();}
  };
  const captureFrame=()=>{
    try {if(!video.current?.videoWidth)throw Error('请先播放视频');const output=document.createElement('canvas');output.width=video.current.videoWidth;output.height=video.current.videoHeight;output.getContext('2d')!.drawImage(video.current,0,0);output.toBlob(blob=>{if(blob)setSource(URL.createObjectURL(blob));else setError('视频帧生成失败');},'image/png');}
    catch(e){setError(e instanceof Error?e.message:String(e));}
  };
  const point=(event: React.PointerEvent<HTMLCanvasElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(event.currentTarget.width,(event.clientX-rect.left)/rect.width*event.currentTarget.width)),y:Math.max(0,Math.min(event.currentTarget.height,(event.clientY-rect.top)/rect.height*event.currentTarget.height))};};
  return createPortal(<div className={styles.mediaOverlay} role="dialog" aria-modal="true" aria-label="截图预览与批注" ref={dialog} tabIndex={-1} onKeyDown={event=>{
    event.stopPropagation();
    if(event.key==='Tab') {const controls=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,video'));if(controls.length){const current=controls.indexOf(document.activeElement as HTMLElement);if(event.shiftKey && current<=0){event.preventDefault();controls.at(-1)!.focus();}else if(!event.shiftKey && current===controls.length-1){event.preventDefault();controls[0].focus();}}return;}
    if(isComposingKey(event))return;
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
      {([['move','移动 V'],['rect','矩形 R'],['arrow','箭头 A'],['text','文字 T'],['redact','打码 B']] as const).map(([id,label])=><button key={id} disabled={!ready} aria-pressed={tool===id} onClick={()=>{commitText();setTool(id);}}>{label}</button>)}
      <input aria-label="批注颜色" type="color" value={color} onChange={event=>setColor(event.target.value)}/>
      {tool==='text'&&<small>点击图片输入文字 · Enter 完成 · 点击已有文字重新编辑</small>}
      <button disabled={!past.current.length&&!editor} onClick={undo} title="Ctrl+Z">撤销</button><button disabled={!future.length} onClick={redo} title="Ctrl+Shift+Z / Ctrl+Y">重做</button>
      <button disabled={!ready} onClick={()=>setZoom(value=>Math.max(.05,value*.8))}>−</button><span>{Math.round(zoom*100)}%</span><button disabled={!ready} onClick={()=>setZoom(value=>Math.min(4,value*1.25))}>+</button><button disabled={!ready} onClick={fit}>适应 0</button><button disabled={!ready} onClick={()=>setZoom(1)}>原图 1</button>
    </div>
    <div className={styles.previewStage} ref={stage}>
      {!source&&<div className={styles.videoPreview}><video ref={video} controls preload="metadata" src={mediaUrl(item)} onLoadedData={()=>setVideoReady(true)} onError={()=>setError('录屏加载失败，请关闭后重试')}/><button disabled={!videoReady} onClick={captureFrame}>{videoReady?'截取当前帧并批注':'正在加载录屏…'}</button></div>}
      <div className={styles.annotationSurface} hidden={!source} style={{width:image.current?image.current.naturalWidth*zoom:undefined}}>
      <canvas ref={canvas} hidden={!source} style={{display:source?'block':'none',width:image.current?image.current.naturalWidth*zoom:undefined,cursor:tool==='move'?'grab':tool==='text'?'text':'crosshair'}} onPointerDown={event=>{
        if(!ready||event.button!==0||busy)return;event.preventDefault();if(commitText()===null)return;
        const p=point(event),ctx=event.currentTarget.getContext('2d')!;ctx.font=`600 ${textFontSize(event.currentTarget.width)}px system-ui`;
        const hit=(tool==='move'||tool==='text')?textMarkAt(marksRef.current,p.x,p.y,event.currentTarget.width,text=>ctx.measureText(text).width):-1;
        if(hit>=0){startText({index:hit,mark:{...marksRef.current[hit]}});return;}
        if(tool==='text'){startText({index:null,mark:{tool,...p,endX:p.x,endY:p.y,text:'',color}});return;}
        event.currentTarget.setPointerCapture(event.pointerId);
        if(tool==='move'){pan.current={x:event.clientX,y:event.clientY,left:stage.current!.scrollLeft,top:stage.current!.scrollTop};return;}
        pending.current={tool,...p,endX:p.x,endY:p.y,text:'',color};
      }} onPointerMove={event=>{
        if(pan.current){stage.current!.scrollLeft=pan.current.left+pan.current.x-event.clientX;stage.current!.scrollTop=pan.current.top+pan.current.y-event.clientY;return;}
        if(!pending.current)return;const p=point(event);pending.current={...pending.current,endX:p.x,endY:p.y};repaint(pending.current);
      }} onPointerUp={event=>{
        if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);pan.current=undefined;
        if(pending.current){const mark=pending.current;pending.current=undefined;if(marksRef.current.length>=200){setError('单张图片最多 200 个批注');repaint();return;}if(Math.abs(mark.endX-mark.x)+Math.abs(mark.endY-mark.y)>3){writeMarks([...marksRef.current,mark]);}else repaint();}
      }} onPointerCancel={()=>{pan.current=undefined;pending.current=undefined;repaint();}}/>
      {editor&&<input ref={textInput} className={styles.annotationTextInput} aria-label="画布文字批注" placeholder="输入文字，Enter 完成" maxLength={200} value={editor.mark.text}
        style={{left:editor.mark.x*zoom,top:editor.mark.y*zoom,fontSize:Math.max(10,textFontSize(canvas.current?.width||720)*zoom),color:editor.mark.color,width:Math.max(120,Math.min(600,(editor.mark.text.length+2)*textFontSize(canvas.current?.width||720)*zoom))}}
        onChange={event=>startText({...editor,mark:{...editor.mark,text:event.target.value}})} onBlur={()=>commitText()}
        onKeyDown={event=>{if(isComposingKey(event))return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();editorRef.current=undefined;setEditor(undefined);dialog.current?.focus();}else if(event.key==='Enter'&&!event.ctrlKey&&!event.metaKey){event.preventDefault();event.stopPropagation();commitText();dialog.current?.focus();}}}/>}
      </div>
    </div>
    <footer className={styles.previewFooter}><div>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<small>快捷键仅在预览内生效 · Ctrl+Enter 加入对话 · 批注另存为附件，原图不变</small></div><button disabled={!ready||busy} onClick={()=>void add()}>{busy?'正在加入…':'加入当前对话 Ctrl+Enter'}</button></footer>
  </div>,document.body);
}
