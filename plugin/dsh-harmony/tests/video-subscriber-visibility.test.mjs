import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
const compiled=await build({entryPoints:['vendor/hooks/useHarmonyLiveFrame.ts'],bundle:true,format:'cjs',platform:'browser',jsx:'automatic',write:false,external:['react','react-dom/client','react/jsx-runtime'],alias:{'@/lib/harmony/media/live-video-hub':path.resolve('vendor/lib/harmony/media/live-video-hub.tsx')},plugins:[{name:'engine-seam',setup(b){b.onResolve({filter:/useHarmonyLiveFrameEngine$/},()=>({path:'engine',namespace:'seam'}));b.onLoad({filter:/.*/,namespace:'seam'},()=>({contents:'export const useHarmonyLiveFrameEngine=globalThis.engine;',loader:'js'}));}}]});
function fixture(hidden){
 const slots=[],effects=[],timers=new Map(),events=new Map();let index=0,nested=false,id=0,starts=0;const visibility=[];
 const react={useMemo:fn=>fn(),useCallback:fn=>fn,useState(initial){const i=index++;slots[i]??={value:initial};return [slots[i].value,v=>{slots[i].value=typeof v==='function'?v(slots[i].value):v;}];},useRef(initial){const i=index++;return slots[i]??=( {current:initial});},useEffect(fn){if(nested){fn();return;}index++;effects.push(fn);}};
 const document={hidden,addEventListener:(n,fn)=>events.set(n,fn),removeEventListener:n=>events.delete(n),createElement:()=>({width:100,height:200,getContext:()=>({drawImage(){}})})};
 const module={exports:{}},jsx=(type,props)=>({type,props});
 runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,document,window:{addEventListener:(n,fn)=>events.set(n,fn),removeEventListener:n=>events.delete(n)},Date,setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),engine:options=>{starts++;visibility.push(options.renderVisibleRef.current);return {frame:{generation:options.generation,width:100,height:200},status:'live',mode:'video',phase:'live'};},require:name=>name==='react'?{...react,default:react}:name==='react-dom/client'?{createRoot:()=>({render(element){nested=true;try{element.type(element.props);}finally{nested=false;}},unmount(){}})}:{jsx,jsxs:jsx}});
 const options={active:true,enabled:true,serial:'test',generation:1,canvasRef:{current:{width:100,height:200,getContext:()=>({drawImage(){}})}}};
 module.exports.useHarmonyLiveFrame(options);const cleanups=effects.map(fn=>fn());
 return {visibility,get starts(){return starts;},show(){document.hidden=false;events.get('visibilitychange')();},hide(){document.hidden=true;events.get('visibilitychange')();},idle(){for(const [id,t]of [...timers]){timers.delete(id);t.fn();}},dispose(){for(const fn of cleanups)fn?.();events.get('pagehide')?.();}};
}
test('a subscriber mounted while hidden becomes visible on its first acquisition',()=>{const f=fixture(true);try{assert.equal(f.starts,0);f.show();assert.deepEqual(f.visibility,[true]);}finally{f.dispose();}});
test('the same subscriber is visible after ten-minute Hub expiry',()=>{const f=fixture(false);try{f.hide();f.idle();f.show();assert.equal(f.starts,2);assert.deepEqual(f.visibility,[true,true]);}finally{f.dispose();}});
