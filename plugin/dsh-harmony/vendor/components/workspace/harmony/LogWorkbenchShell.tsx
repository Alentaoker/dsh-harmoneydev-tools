"use client";

import { useEffect, useState } from "react";
import styles from "../HarmonyPanel.module.css";
import { HarmonyLogViewer } from "../HarmonyLogViewer";
import { SessionLogPane } from "./SessionLogPane";

export type LogWorkbenchTab = "live" | "session";
const TAB_KEY = "dshHarmony.logWorkbenchTab";

function storedTab(): LogWorkbenchTab {
  try { return sessionStorage.getItem(TAB_KEY) === "session" ? "session" : "live"; } catch { return "live"; }
}

/**
 * One shell for both log views.
 *
 * The live pane stays mounted so it keeps its filters, find text, selected row,
 * scroll position and pause state. Only the visible pane refreshes: the hidden
 * live pane keeps collecting without re-rendering or scanning.
 *
 * The session pane is the real dshE2E workbench (see SessionLogPane), so import,
 * delete, rename, packages, pagination and analysis are not duplicated here.
 */
export function LogWorkbenchShell({ active, serial, online, sessionId, copy, onDraft }: {
  active: boolean;
  serial: string;
  online: boolean;
  sessionId?: string;
  copy: (zh: string, en: string) => string;
  onDraft?: (text: string) => void;
}) {
  // A first visit always starts on the current device's live logs; a later
  // visit returns to the view the person last used.
  const [tab, setTab] = useState<LogWorkbenchTab>(storedTab);
  const [focusFileId, setFocusFileId] = useState<string>();
  useEffect(() => { try { sessionStorage.setItem(TAB_KEY, tab); } catch { /* Storage may be unavailable. */ } }, [tab]);

  const tabs: Array<{ id: LogWorkbenchTab; label: string }> = [
    { id: "live", label: copy("实时日志", "Live logs") },
    { id: "session", label: copy("会话日志", "Session logs") },
  ];
  const select = (next: LogWorkbenchTab) => setTab(next);
  const openSavedFile = (fileId: string) => { setTab("session"); setFocusFileId(fileId); };

  return <section className={styles.logWorkbench} data-log-workbench="" data-active-tab={tab}>
    <div className={styles.logWorkbenchTabs} role="tablist" aria-label={copy("日志工作台", "Log workbench")}>
      {tabs.map(({ id, label }) => <button key={id} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
        id={`log-workbench-${id}`} aria-controls={`log-workbench-panel-${id}`} data-live={id === "live" ? (online ? "true" : "false") : undefined}
        onClick={() => select(id)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const next = tabs[(tabs.findIndex(item => item.id === tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          select(next.id);
          document.getElementById(`log-workbench-${next.id}`)?.focus();
        }}>
        {label}{id === "live" ? <i className={styles.logWorkbenchDot} data-state={online ? "on" : "off"} aria-hidden="true" /> : null}
      </button>)}
      {sessionId ? null : <small>{copy("会话日志需要先打开会话", "Session logs need an open session")}</small>}
    </div>
    <div role="tabpanel" id="log-workbench-panel-live" aria-labelledby="log-workbench-live" hidden={tab !== "live"} className={styles.logWorkbenchPanel}>
      <HarmonyLogViewer active={active} visible={active && tab === "live"} serial={serial} online={online} copy={copy}
        onSavedToSession={openSavedFile} onShowSessionLogs={() => setTab("session")} />
    </div>
    <div role="tabpanel" id="log-workbench-panel-session" aria-labelledby="log-workbench-session" hidden={tab !== "session"} className={styles.logWorkbenchPanel}>
      <SessionLogPane active={active && tab === "session"} sessionId={sessionId} focusFileId={focusFileId}
        onFocusConsumed={() => setFocusFileId(undefined)} onDraft={onDraft} />
    </div>
  </section>;
}
