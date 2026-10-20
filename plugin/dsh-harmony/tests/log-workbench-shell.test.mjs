import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

/**
 * Source contracts for the workbench wiring. These guard the exact behaviours
 * that a headless run cannot exercise without a browser and a device; real
 * interaction still needs the manual acceptance pass.
 */
const panel = await readFile('vendor/components/workspace/HarmonyPanel.tsx', 'utf8');
const viewer = await readFile('vendor/components/workspace/HarmonyLogViewer.tsx', 'utf8');
const shell = await readFile('vendor/components/workspace/harmony/LogWorkbenchShell.tsx', 'utf8');
const sessionPane = await readFile('vendor/components/workspace/harmony/SessionLogPane.tsx', 'utf8');
const history = await readFile('vendor/components/workspace/harmony/LogSearchHistory.tsx', 'utf8');
const preview = await readFile('vendor/components/workspace/harmony/MediaPreview.tsx', 'utf8');
const build = await readFile('scripts/build.mjs', 'utf8');

test('the device page has a fixed device/log entry and no daily connect button', () => {
  assert.match(panel, /role="tablist" aria-label=\{copy\("工作台视图"/);
  assert.match(panel, /copy\("设备", "Device"\)/);
  assert.match(panel, /copy\("日志工作台", "Log workbench"\)/);
  assert.doesNotMatch(panel, /copy\("接入实时视频", "Connect live video"\)/, 'the daily flow must not need a manual connect button');
  assert.match(panel, /copy\("立即重试", "Retry now"\)/, 'an abnormal state keeps a secondary retry');
});

test('the device page explains the waiting state instead of showing a generic error', () => {
  assert.match(panel, /data-phase=\{framePhase\}/);
  assert.match(panel, /copy\("手机已锁屏 · 解锁后自动连接", "Phone locked · connects automatically after you unlock"\)/);
  assert.match(panel, /copy\("手机已熄屏 · 唤醒并解锁后自动连接", "Screen off · connects automatically after you wake and unlock"\)/);
  assert.match(panel, /online: Boolean\(selectedOnline\)/);
});

test('diagnostics report measured values, not a guess', () => {
  for (const metric of ['channel', 'phase', 'drawn', 'dropped', 'first', 'recovery', 'queue', 'backlog', 'resyncs', 'probes', 'screen']) {
    assert.match(panel, new RegExp(`data-metric="${metric}"`), metric);
  }
});

test('both log views live in one shell and stay mounted', () => {
  assert.match(shell, /data-log-workbench=""/);
  assert.match(shell, /copy\("实时日志", "Live logs"\)/);
  assert.match(shell, /copy\("会话日志", "Session logs"\)/);
  // Hidden panes are hidden with `hidden`, never unmounted, so their filters,
  // scroll and selection survive a switch.
  assert.match(shell, /hidden=\{tab !== "live"\}/);
  assert.match(shell, /hidden=\{tab !== "session"\}/);
  assert.doesNotMatch(shell, /tab === "live" \? <HarmonyLogViewer/);
});

test('a hidden live pane keeps capturing but stops refreshing the list', () => {
  assert.match(viewer, /visible\?: boolean;/);
  assert.match(viewer, /if \(!visibleRef\.current\) return;/, 'the display flush is skipped while hidden');
  assert.match(viewer, /const visibleRef = useRef\(visible\)/, 'the live subscription is not tied to visibility');
  // The device stream subscription must stay keyed on `active`, not `visible`.
  assert.match(viewer, /new EventSource\(`\/api\/harmony\/logs\/events\?serial=\$\{encodeURIComponent\(serial\)\}`\)/);
  assert.match(viewer, /\}, \[active, online, refreshKey, serial\]\);/);
});

test('saving live logs offers a file view that switches the workbench', () => {
  assert.match(viewer, /copy\('查看文件', 'View file'\)/);
  assert.match(viewer, /onSavedToSession\(savedFile\.id\)/);
  assert.match(shell, /const openSavedFile = \(fileId: string\) => \{ setTab\("session"\); setFocusFileId\(fileId\); \}/);
});

test('session logs are the real dshE2E workbench, not a second viewer', () => {
  // Reuse is the requirement: import, drag-and-drop, delete/restore, rename,
  // packages, pagination, app/TAG filters and AI drafts stay in one place.
  assert.match(sessionPane, /import "\@dsh-e2e-workbench-css";/);
  assert.match(sessionPane, /import \{ LogWorkbench \} from "\@dsh-e2e-workbench";/);
  assert.match(sessionPane, /<LogWorkbench visible=\{active\} sessionId=\{sessionId\} openFileId=\{focusFileId\} onOpenFileConsumed=\{onFocusConsumed\} onDraft=\{onDraft\} \/>/);
  assert.match(sessionPane, /className="[^"]*\bde2e\b[^"]*"/, 'dshE2E scopes its styles under .de2e');
  // A requested file is honoured once; the caller clears it so a later tab switch
  // keeps whatever file the person opened by hand.
  assert.match(shell, /onFocusConsumed=\{\(\) => setFocusFileId\(undefined\)\}/);
  // No reduced re-implementation: no local endpoint calls, list paging, or
  // regex compilation of its own.
  assert.doesNotMatch(sessionPane, /\/api\/dsh-e2e\/log-library/);
  assert.doesNotMatch(sessionPane, /new RegExp\(/);
  assert.doesNotMatch(sessionPane, /PAGE_SIZE|setOffset|<ul|libraryRequest/);
  assert.ok(sessionPane.split('\n').length < 60, 'the pane stays a thin wrapper');
});

test('the search-history rules have exactly one implementation', async () => {
  // Canonical rules live in dshE2E so the session-log viewer and this live pane
  // cannot disagree; the local copy exists only for a standalone build and is
  // compared against the canonical one in tests/log-search-menu.test.mjs.
  assert.match(history, /export \{ historyKeyAction, isComposingKey, nextCursor, filterHistoryEntries \} from "\@dsh-log-search-menu";/);
  assert.match(build, /const pairedSearchMenu = path\.join\(pairedWorkbench, 'log-search-menu\.mjs'\);/);
  assert.match(build, /'@dsh-log-search-menu': usePairedSearchMenu \? pairedSearchMenu : src\('log-search-menu-unpaired\.ts'\)/);
  await assert.rejects(access('vendor/lib/harmony/log-search-menu.ts'), 'the duplicate rules module must not come back');
  const fallback = await readFile('src/log-search-menu-unpaired.ts', 'utf8');
  for (const name of ['isComposingKey', 'historyKeyAction', 'nextCursor', 'filterHistoryEntries']) {
    assert.match(fallback, new RegExp(`export function ${name}`), name);
  }
});

test('the paired workbench is resolved at build time with an explicit fallback', () => {
  assert.match(build, /const usePairedWorkbench = fs\.existsSync\(path\.join\(pairedWorkbench, 'LogWorkbench\.jsx'\)\)/);
  assert.match(build, /'@dsh-e2e-workbench': usePairedWorkbench \? path\.join\(pairedWorkbench, 'LogWorkbench\.jsx'\) : src\('session-log-workbench-unpaired\.tsx'\)/);
  assert.match(build, /console\.warn\(/, 'a standalone build must say it cannot show the full session-log workbench');
});

test('the find box never re-implements the bounded pattern dialect', () => {
  assert.doesNotMatch(sessionPane, /\.test\(/, 'the session view must use dshE2E compilePattern');
  assert.doesNotMatch(viewer, /new RegExp\(/, 'the live view uses createLogMatcher');
  assert.match(history, /validateLogRegex/, 'history refuses patterns the viewer would reject');
});

test('search history is visible, refreshed on open and never applied implicitly', () => {
  assert.match(viewer, /useLogSearchHistory\("filter"/);
  assert.match(viewer, /useLogSearchHistory\("find"/);
  assert.match(viewer, /copy\("查找历史", "Find history"\)/);
  assert.match(viewer, /copy\("筛选历史", "Filter history"\)/);
  // Shared file, so re-read when the list opens instead of trusting mount time.
  assert.match(viewer, /const openFilterHistory = \(\) => \{ setFindHistoryOpen\(false\); setFilterHistoryOpen\(true\); setFilterSelected\(false\); filterHistory\.reload\(\); \}/);
  assert.match(viewer, /const openFindHistory = \(\) => \{ setFilterHistoryOpen\(false\); setFindHistoryOpen\(true\); setFindSelected\(false\); findHistory\.reload\(\); \}/);
  assert.match(viewer, /data-history-anchor="filter"/);
  assert.match(viewer, /data-history-anchor="find"/);
  // Enter applies a history entry only after explicit selection, and editing the
  // keyword drops that selection so the next Enter cannot overwrite it.
  assert.match(viewer, /selected: filterSelected/);
  assert.match(viewer, /selected: findSelected/);
  assert.match(viewer, /onChange=\{\(event\) => \{ setFilterSelected\(false\); setQuery\(event\.target\.value\); \}\}/);
  assert.match(viewer, /onChange=\{event => \{ setFindSelected\(false\); setFindText\(event\.target\.value\); \}\}/);
  assert.match(viewer, /if \(isComposingKey\(event\)\) return;/);
});

test('the tools drawer does not close on an Escape consumed by an inner control or an IME', () => {
  // The find box and the history menu consume their own Escape; a composition in
  // progress owns the key entirely. Closing the whole workbench would be wrong.
  assert.match(panel, /if \(event\.defaultPrevented \|\| isComposingKey\(event\)\) return;/);
  assert.match(panel, /import \{ isComposingKey \} from "\@dsh-log-search-menu";/);
  // The live pane's own search boxes keep using the same guard.
  assert.match(viewer, /if \(isComposingKey\(event\)\) return;/);
});

test('an annotated image closes the preview only after a successful add', () => {
  const addBlock = preview.slice(preview.indexOf('const add=async()=>{'), preview.indexOf('const captureFrame='));
  const attachIndex = addBlock.indexOf('await attach(');
  const closeIndex = addBlock.indexOf('onAdded?.();');
  assert.ok(attachIndex > 0 && closeIndex > attachIndex, 'the preview closes after the attachment is accepted');
  assert.match(addBlock, /skipFocusRestore\.current=true;/, 'the dialog must not steal focus back from the conversation');
  assert.match(addBlock, /adding\.current=true;setBusy\(true\)/, 'a duplicate submit is blocked');
  // Failures keep the dialog and every mark.
  assert.match(addBlock, /catch\(e\)\{setError\(/);
  assert.doesNotMatch(addBlock, /catch\(e\)\{[^}]*onClose/);
});
