// Retire only saved UI tabs from the old plugin; stored logs and records stay.
export function retireLegacyLogTabs(sidebar, sessionId) {
  if (!sessionId || typeof sidebar?.tabsIn !== 'function' || typeof sidebar?.closeIn !== 'function') return;
  try { for (const tab of [...sidebar.tabsIn(sessionId)]) {
    if (tab.kind === 'dshE2E') { try { sidebar.closeIn(sessionId, tab.id); } catch {} }
  } } catch {}
}
