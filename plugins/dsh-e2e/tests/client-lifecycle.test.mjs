import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(viewer = false) {
  const state=[],effects=[],queue=[],requests=[],timers=new Map();let cursor=0,timerId=0,Panel,exports;
  const jsx=(type,props)=>({type,props});
  const react={useRef(initial){const i=cursor++;if(!(i in state))state[i]={current:initial};return state[i];},useMemo(fn){cursor++;return fn();},useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value;}];},useEffect(fn,deps){const i=cursor++,previous=effects[i];if(!previous||deps.some((v,j)=>!Object.is(v,previous.deps[j])))queue.push(()=>{previous?.cleanup?.();effects[i]={deps,cleanup:fn()};});}};
  const context={window:{__ModuleLoader__:{load:module=>{exports=module.factory(name=>name==='react'?react:{jsx,jsxs:jsx});}}},document:{getElementById:()=>({}),head:{appendChild(){}},addEventListener(){},removeEventListener(){}},AbortController,URLSearchParams,Date,Number,String,JSON,URL,
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    fetch(url,options={}){return new Promise(resolve=>requests.push({url,signal:options.signal,resolve}));},
  };
  if(viewer){
    const result=await build({entryPoints:[fileURLToPath(new URL('../src/LogViewer.jsx',import.meta.url))],bundle:true,format:'cjs',platform:'browser',jsx:'automatic',external:['react','react/jsx-runtime'],write:false});
    const module={exports:{}};runInNewContext(result.outputFiles[0].text,{...context,module,exports:module.exports,require:name=>name==='react'?react:{jsx,jsxs:jsx}});Panel=module.exports.LogViewer;
  }else runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),context);
  const ctx={effect:fn=>fn(),sidebarRightTabs:{register(){}},slots:{inject:(_name,fn)=>fn(),register:(slot,component)=>{if(slot.name==='sidebar.right.pane.tab')Panel=component;}},sessions:{scope:id=>({id})},conversation:{input:{for:()=>({setDraft(){}})}}};if(!viewer)exports.apply(ctx);
  const render=(sessionId,visible)=>{cursor=0;const tree=Panel(viewer?{url:"/logs?id=test",visible}:{sessionId,useTabInfo:()=>({tab:{visible}})});while(queue.length)queue.shift()();return tree;};
  const reply=(request,value)=>request.resolve(new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}}));
  const text=tree=>{if(tree==null||typeof tree==='boolean')return '';if(typeof tree!=='object')return String(tree);if(Array.isArray(tree))return tree.map(text).join(' ');return text(tree.props?.children);};
  return{render,reply,requests,timers,text,dispose(){for(const e of effects)e?.cleanup?.();}};
}
test('隐藏面板不开请求；显示后读取；隐藏取消请求、清理轮询并拒收迟到响应',async()=>{
  const h=await harness();try{
    h.render('first',false);assert.equal(h.requests.length,0);
    h.render('first',true);assert.equal(h.requests.length,2);const pending=[...h.requests];
    h.render('first',false);assert.ok(pending.every(r=>r.signal.aborted));
    for(const r of pending)h.reply(r,r.url.includes('/status')?{active:[]}:{runs:[{id:'foreign',name:'迟到的旧记录'}],counts:{},filteredTotal:1,nextOffset:null});await tick();
    assert.equal(h.text(h.render('first',false)).includes('迟到的旧记录'),false);assert.equal([...h.timers.values()].some(t=>t.ms===15000),false);
    h.render('first',true);assert.equal(h.requests.length,4);
  }finally{h.dispose();}
});
test('切会话取消旧读取；旧响应不能覆盖新会话记录',async()=>{
  const h=await harness();try{
    h.render('first',true);const old=[...h.requests];
    h.render('second',true);assert.ok(old.every(r=>r.signal.aborted));const current=h.requests.slice(2);assert.ok(current.every(r=>r.url.includes('sessionId=second')));
    for(const r of current)h.reply(r,r.url.includes('/status')?{active:[],devices:[]}:{runs:[{id:'new',name:'新会话报告',status:'passed'}],counts:{all:1,passed:1},filteredTotal:1,nextOffset:null,offset:0});await tick();
    for(const r of old)h.reply(r,r.url.includes('/status')?{active:[]}:{runs:[{id:'old',name:'旧会话报告'}],counts:{all:1},filteredTotal:1,nextOffset:null});await tick();
    const text=h.text(h.render('second',true));assert.equal(text.includes('新会话报告'),true);assert.equal(text.includes('旧会话报告'),false);
  }finally{h.dispose();}
});
test('日志页被正文大小缩短后，上一页回到真实起点，不固定减去 100',async()=>{
  const h=await harness(true);const find=(tree,label)=>{if(!tree||typeof tree!=='object')return;if(Array.isArray(tree)){for(const child of tree){const result=find(child,label);if(result)return result;}return;}if(tree.type==='button'&&h.text(tree).includes(label))return tree;return find(tree.props?.children,label);};
  try{
    h.render('one',true);h.reply(h.requests.at(-1),{total:210,filteredTotal:210,offset:0,entries:[],nextOffset:69});await tick();
    find(h.render('one',true),'下一页').props.onClick();h.render('one',true);assert.ok(h.requests.at(-1).url.includes('offset=69'));h.reply(h.requests.at(-1),{total:210,filteredTotal:210,offset:69,entries:[],nextOffset:140});await tick();
    find(h.render('one',true),'下一页').props.onClick();h.render('one',true);assert.ok(h.requests.at(-1).url.includes('offset=140'));h.reply(h.requests.at(-1),{total:210,filteredTotal:210,offset:140,entries:[],nextOffset:200});await tick();
    find(h.render('one',true),'上一页').props.onClick();h.render('one',true);assert.ok(h.requests.at(-1).url.includes('offset=69'));
  }finally{h.dispose();}
});