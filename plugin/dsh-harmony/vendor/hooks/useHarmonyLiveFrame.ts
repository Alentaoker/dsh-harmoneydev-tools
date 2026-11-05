"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {acquireDeviceVideo} from '@/lib/harmony/media/live-video-hub';
import type {UseHarmonyLiveFrameOptions, HarmonyLiveFrameMetrics} from './useHarmonyLiveFrameEngine';
export type {HarmonyLiveFrame,HarmonyFrameStatus,HarmonyFrameMode,HarmonyLiveFrameMetrics,HarmonyLiveViewPhase} from './useHarmonyLiveFrameEngine';
const emptyMetrics=():HarmonyLiveFrameMetrics=>({channel:'idle',phase:'offline',drawnFrames:0,drawnFps:0,droppedFrames:0,firstFrameMs:null,lastRecoveryMs:null,queueDepth:0,backlogBytes:0,resyncs:0,screenProbes:0,screenProbeFailures:0,screen:null});
export function useHarmonyLiveFrame(options:UseHarmonyLiveFrameOptions){
 const [value,setValue]=useState<any>(null);const handle=useRef<ReturnType<typeof acquireDeviceVideo>|null>(null);const metrics=useRef(emptyMetrics());
 const refresh=useCallback(()=>handle.current?.refresh(),[]);
 useEffect(()=>{
  if(!options.active||!options.enabled||!options.serial||options.generation===undefined){setValue(null);return;}
  let alive=true;
  try{const subscriber={canvas:options.canvasRef,visible:!document.hidden,notify:(state:any)=>{if(alive)setValue({...state,serial:options.serial});}};
   const visibility=()=>{if(document.hidden){handle.current?.setVisible(false);return;}subscriber.visible=true;if(!handle.current?.isAlive()){handle.current?.release();setValue(null);handle.current=acquireDeviceVideo(options,subscriber);}else handle.current.setVisible(true);};
   if(!document.hidden)visibility();document.addEventListener('visibilitychange',visibility);window.addEventListener('pageshow',visibility);
   return()=>{alive=false;document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pageshow',visibility);handle.current?.release();handle.current=null;};
  }catch(error){setValue({serial:options.serial,generation:options.generation,status:'error',mode:'idle',phase:'recovering',error:error instanceof Error?error.message:String(error),frame:null,metrics:metrics.current});}
 },[options.active,options.enabled,options.serial,options.generation,options.online,options.canvasRef]);
 const current=value?.serial===options.serial?value:null;
 return {frame:current?.frame??null,status:current?.status??'idle',mode:current?.mode??'idle',error:current?.error??null,fallbackReason:current?.fallbackReason??null,videoBlocked:current?.videoBlocked??false,videoRecovery:current?.videoRecovery,phase:current?.phase??'offline',screen:current?.screen??null,metrics:current?.metrics??metrics.current,refresh};
}
