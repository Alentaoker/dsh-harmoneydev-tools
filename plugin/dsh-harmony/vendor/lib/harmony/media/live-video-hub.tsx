import React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {useHarmonyLiveFrameEngine, type UseHarmonyLiveFrameOptions} from '../../../hooks/useHarmonyLiveFrameEngine';

export const HUB_IDLE_MS=10*60*1000;
export const HUB_DEVICE_LIMIT=2;
type Options=UseHarmonyLiveFrameOptions;
type State=ReturnType<typeof useHarmonyLiveFrameEngine>;
type Subscriber={canvas:Options['canvasRef'];notify:(state:State)=>void;visible:boolean};
type Entry={serial:string;options:Options;canvas:HTMLCanvasElement;root:Root;subscribers:Set<Subscriber>;state?:State;timer?:ReturnType<typeof setTimeout>;lastUsed:number;starts:number;visibleRef:{current:boolean};renderChangeRef:{current:(()=>void)|null}};
const entries=new Map<string,Entry>();
function paint(entry:Entry,subscriber:Subscriber){
 if(!subscriber.visible||!entry.state?.frame)return;
 const canvas=subscriber.canvas.current;if(!canvas)return;
 if(canvas.width!==entry.canvas.width)canvas.width=entry.canvas.width;
 if(canvas.height!==entry.canvas.height)canvas.height=entry.canvas.height;
 canvas.getContext('2d')?.drawImage(entry.canvas,0,0);
}
function Engine({entry}:{entry:Entry}){
 const canvasRef=React.useMemo(()=>({current:entry.canvas}),[entry]);
 const onFrame=React.useCallback(()=>{for(const subscriber of entry.subscribers)paint(entry,subscriber);},[entry]);
 const state=useHarmonyLiveFrameEngine({...entry.options,active:true,enabled:true,keepAlive:true,renderVisibleRef:entry.visibleRef,renderChangeRef:entry.renderChangeRef,canvasRef,onFrame});
 React.useEffect(()=>{entry.state=state;for(const subscriber of entry.subscribers){subscriber.notify(state);paint(entry,subscriber);}},[entry,state.frame,state.status,state.mode,state.error,state.phase,state.screen,state.fallbackReason,state.videoBlocked,state.videoRecovery]);
 return null;
}
function destroy(entry:Entry){
 if(entries.get(entry.serial)!==entry)return;
 entries.delete(entry.serial);clearTimeout(entry.timer);entry.root.unmount();entry.canvas.width=1;entry.canvas.height=1;
}
export function releaseAllVideo(){for(const entry of [...entries.values()])destroy(entry);}
export function videoHubDiagnostics(){return [...entries.values()].map(e=>({subscribers:e.subscribers.size,visible:[...e.subscribers].filter(s=>s.visible).length,starts:e.starts,lastFrameBytes:e.canvas.width*e.canvas.height*4,idleMs:HUB_IDLE_MS}));}
export function acquireDeviceVideo(options:Options,subscriber:Subscriber){
 let entry=entries.get(options.serial);
 if(!entry){
  if(entries.size>=HUB_DEVICE_LIMIT){const idle=[...entries.values()].filter(e=>![...e.subscribers].some(s=>s.visible)).sort((a,b)=>a.lastUsed-b.lastUsed)[0];if(idle)destroy(idle);else throw Error('已有两台设备正在投屏，请先关闭其中一台');}
  const canvas=document.createElement('canvas'),container=document.createElement('div');
  entry={serial:options.serial,options,canvas,root:createRoot(container),subscribers:new Set(),lastUsed:Date.now(),starts:1,visibleRef:{current:subscriber.visible},renderChangeRef:{current:null}};entries.set(options.serial,entry);
 }
 const current=entry,wasVisible=current.visibleRef.current;clearTimeout(current.timer);current.timer=undefined;current.lastUsed=Date.now();current.subscribers.add(subscriber);current.visibleRef.current=[...current.subscribers].some(s=>s.visible);
 const generationChanged=(options.generation??0)>Math.max(current.options.generation??0,current.state?.frame?.generation??0);
 if(generationChanged)current.options=options;
 if(!current.state||generationChanged)current.root.render(<Engine entry={current}/>);
 if(current.state){subscriber.notify(current.state);paint(current,subscriber);if(wasVisible!==current.visibleRef.current)current.renderChangeRef.current?.();}
 let released=false;
 return {isAlive:()=>entries.get(current.serial)===current,refresh:()=>current.state?.refresh(),setVisible(visible:boolean){const previous=current.visibleRef.current;subscriber.visible=visible;current.visibleRef.current=[...current.subscribers].some(s=>s.visible);if(previous!==current.visibleRef.current)current.renderChangeRef.current?.();if(visible){clearTimeout(current.timer);current.timer=undefined;paint(current,subscriber);}else armIdle(current);},release(){if(released)return;released=true;const previous=current.visibleRef.current;current.subscribers.delete(subscriber);current.visibleRef.current=[...current.subscribers].some(s=>s.visible);if(previous!==current.visibleRef.current)current.renderChangeRef.current?.();armIdle(current);}};
}
function armIdle(entry:Entry){if(entries.get(entry.serial)!==entry)return;if([...entry.subscribers].some(s=>s.visible))return;clearTimeout(entry.timer);entry.timer=setTimeout(()=>destroy(entry),HUB_IDLE_MS);}
if(typeof window!=='undefined')window.addEventListener('pagehide',releaseAllVideo);
