import React, { useEffect, useState } from 'react';
import { SafeHarmonyPanel } from '../vendor/components/workspace/HarmonyPanel';
import './theme.css';
import { version } from '../package.json';
import { LogSessionContext, appendAnalysisDraft } from './log-session';
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'conversation', 'sessions'];
export function apply(ctx: any) {
  const id = 'dsh-harmony', kind = 'dshHarmony';
  ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind, title: () => 'dshHarmony', guide: [{ id: kind, order: 5, title: () => 'dshHarmony', description: () => '鸿蒙设备控制与测试工作台' }] }), 'dshHarmony: tab');
  function Panel(props: any) {
    const sessionId = props.sessionId;
    const info = props.useTabInfo();
    const [cwd, setCwd] = useState<string>();
    const [openLogRequest, setOpenLogRequest] = useState(0);
    useEffect(() => {
      const key = 'dshHarmony:open-logs:' + sessionId;
      const consume = () => { if (sessionStorage.getItem(key)) { sessionStorage.removeItem(key); setOpenLogRequest(n => n + 1); } };
      const open = (event: any) => { if (event.detail?.sessionId === sessionId) { sessionStorage.removeItem(key); setOpenLogRequest(n => n + 1); } };
      consume(); window.addEventListener('dshHarmony:open-logs', open); return () => window.removeEventListener('dshHarmony:open-logs', open);
    }, [sessionId]);
    useEffect(() => { if (sessionId) fetch(`/api/harmony/dsh-session?sessionId=${encodeURIComponent(sessionId)}`).then(r => r.json()).then(v => setCwd(v.cwd)).catch(() => {}); }, [sessionId]);
    const guide = (prompt?: string) => {
      if (!prompt) return;
      const actx = ctx.sessions.scope(sessionId);
      if (actx) ctx.conversation.input.for(actx).setDraft(prompt);
      else throw new Error('当前会话已关闭，请重新打开会话');
    };
    const openLogs = (fileId?: string) => { if (!sessionId) return; sessionStorage.setItem('dshE2E:open-log:' + sessionId, fileId || '__workbench__'); ctx.sidebarRight.openTabIn(sessionId, 'dshE2E'); window.dispatchEvent(new CustomEvent('dshE2E:open-logs', { detail: { sessionId, id: fileId } })); };
    const analyze = (text: string) => { const session = sessionId && ctx.sessions.scope(sessionId); if (!session) throw Error('请先打开一个会话'); appendAnalysisDraft(ctx.conversation.input.for(session), text); };
    return <div className="dshHarmony"><LogSessionContext.Provider value={{ sessionId, onOpenLogs: openLogs, onAnalyze: analyze }}><SafeHarmonyPanel openLogRequest={openLogRequest} active={info.tab.visible} cwd={cwd} pluginVersion={version} onOpenLocalTerminal={() => ctx.sidebarRight.openTabIn(sessionId, 'terminal')} onGuideAgent={guide} /></LogSessionContext.Provider></div>;
  }
  function Header(props: any) { return <button title="鸿蒙设备控制与测试工作台" onClick={() => props.sessionId ? ctx.sidebarRight.openTabIn(props.sessionId, kind) : ctx.sidebarRight.openTab(kind)}>dshHarmony</button>; }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Panel)), 'dshHarmony: body');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: id }, () => <span>dshHarmony</span>)), 'dshHarmony: title');
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'dshHarmony', order: 30 }, Header)), 'dshHarmony: entry');
  const openTerminal = () => ctx.sidebarRight.openTab('terminal');
  ctx.effect(() => { window.addEventListener('dshHarmony:terminal', openTerminal); return () => window.removeEventListener('dshHarmony:terminal', openTerminal); });
}
