import React,{useEffect,useState} from 'react';
import {LogWorkbench} from './LogWorkbench.jsx';
import {appendLogDraft} from './log-client.mjs';
import {retireLegacyLogTabs} from './legacy-tabs.mjs';
import './client.css';
export const inject=['slots','sidebarRight','sidebarRightTabs','conversation','sessions'];
export function apply(ctx){
 const id='dsh-log-analysis',kind='dshLogAnalysis';
 ctx.effect(()=>ctx.sidebarRightTabs.register({id,kind,title:()=>'日志分析',guide:[{id:kind,order:6,title:()=>'日志分析'}]}),'dshLogAnalysis: tab');
 function Panel(props){const sessionId=props.sessionId,info=props.useTabInfo?.(),visible=info?.tab?.visible!==false;const [openFileId,setOpenFileId]=useState();
 useEffect(()=>retireLegacyLogTabs(ctx.sidebarRight,sessionId),[sessionId]);
 useEffect(()=>{const key='dshLogAnalysis:open-log:'+sessionId;const consume=()=>{const value=sessionStorage.getItem(key);if(value){setOpenFileId(value==='__workbench__'?undefined:value);sessionStorage.removeItem(key);}};setOpenFileId(undefined);consume();const open=event=>{if(event.detail?.sessionId===sessionId){setOpenFileId(event.detail.id==='__workbench__'?undefined:event.detail.id);sessionStorage.removeItem(key);}};window.addEventListener('dshLogAnalysis:open-logs',open);return()=>window.removeEventListener('dshLogAnalysis:open-logs',open);},[sessionId]);
 const draft=text=>{if(!sessionId)throw Error('请先打开一个会话');const session=ctx.sessions.scope(sessionId);if(!session)throw Error('会话已关闭');appendLogDraft(ctx.conversation.input.for(session),text);};
 const realtime=()=>{if(!sessionId)return;sessionStorage.setItem('dshHarmony:open-logs:'+sessionId,'1');ctx.sidebarRight.openTabIn(sessionId,'dshHarmony');window.dispatchEvent(new CustomEvent('dshHarmony:open-logs',{detail:{sessionId}}));};
 return <div className="de2e log-analysis"><LogWorkbench visible={visible} sessionId={sessionId} onDraft={draft} onRealtime={realtime} openFileId={openFileId} onOpenFileConsumed={()=>setOpenFileId(undefined)}/></div>;
 }
 function Header(props){useEffect(()=>retireLegacyLogTabs(ctx.sidebarRight,props.sessionId),[props.sessionId]);return <button title="dsh-log-analysis" onClick={()=>props.sessionId?ctx.sidebarRight.openTabIn(props.sessionId,kind):ctx.sidebarRight.openTab(kind)}>日志分析</button>;}
 ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:id},Panel)),'dshLogAnalysis: pane');
 ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:id},()=> <span>日志分析</span>)),'dshLogAnalysis: title');
 ctx.effect(()=>ctx.slots.inject('conversation.session.header.actions',()=>ctx.slots.register({name:'conversation.session.header.actions',id:kind,order:31},Header)),'dshLogAnalysis: entry');
}
