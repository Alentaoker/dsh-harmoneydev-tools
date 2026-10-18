import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['src/log-search-menu.mjs'], bundle: true, format: 'esm', write: false });
const { historyKeyAction, isComposingKey, nextCursor, filterHistoryEntries } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

const viewer = await readFile('src/LogViewer.jsx', 'utf8');
const workbench = await readFile('src/LogWorkbench.jsx', 'utf8');
const history = await readFile('src/LogSearchHistory.jsx', 'utf8');
const menu = await readFile('src/log-search-menu.mjs', 'utf8');
const client = await readFile('src/client.jsx', 'utf8');

const open = { open: true, cursor: 0, count: 3, selected: true };

test('Enter applies history only after an explicit selection', () => {
  assert.equal(historyKeyAction({ key: 'Enter' }, { ...open, selected: false }), null);
  assert.equal(historyKeyAction({ key: 'Enter' }, open), 'apply');
  assert.equal(historyKeyAction({ key: 'Enter' }, { ...open, count: 0 }), null);
});

test('React synthetic and native composition markers both suppress shortcuts', () => {
  assert.equal(isComposingKey({ isComposing: true }), true);
  assert.equal(isComposingKey({ keyCode: 229 }), true);
  assert.equal(isComposingKey({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isComposingKey({ nativeEvent: { keyCode: 229 } }), true);
  assert.equal(isComposingKey({ keyCode: 13, nativeEvent: { isComposing: false } }), false);
  assert.equal(historyKeyAction({ key: 'Enter', nativeEvent: { isComposing: true } }, open), null);
});

test('the rules module stays free of imports so it can be shared', () => {
  assert.doesNotMatch(menu, /^\s*import /m, 'the shared rules must not depend on React or any bundle');
});

test('both search boxes in the session-log viewer use the shared history', () => {
  assert.match(viewer, /import \{ useLogSearchHistory, LogSearchHistoryMenu \} from '\.\/LogSearchHistory\.jsx';/);
  assert.match(viewer, /const queryHistory = useLogSearchHistory\('filter'\), findHistory = useLogSearchHistory\('find'\);/);
  assert.match(viewer, /onFocus=\{\(\) => openQueryHistory\(\)\}/);
  assert.match(viewer, /onFocus=\{\(\) => openFindHistory\(\)\}/);
  assert.match(viewer, /<LogSearchHistoryMenu entries=\{queryHistory\.entries\}/);
  assert.match(viewer, /<LogSearchHistoryMenu entries=\{findHistory\.entries\}/);
  assert.match(viewer, /selected: querySelected/);
  assert.match(viewer, /selected: findSelected/);
});

test('editing a keyword drops the history selection so Enter cannot overwrite it', () => {
  assert.match(viewer, /onChange=\{e => \{ setQuerySelected\(false\); change\('query', e\.target\.value\); \}\}/);
  assert.match(viewer, /onChange=\{e => \{ setFindSelected\(false\); setFind\(e\.target\.value\); \}\}/);
});

test('closing the find bar consumes Escape so the outer panel stays open', () => {
  assert.match(viewer, /if \(e\.key === 'Escape' && !findHistoryOpen\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); setFindOpen\(false\); setFind\(''\); \}/);
  // History Escape is consumed by the shared rule before reaching the find bar.
  assert.match(viewer, /if \(action === 'close'\) \{ event\.preventDefault\(\); event\.stopPropagation\(\);/);
  assert.match(viewer, /if \(isComposingKey\(e\)\) return;/);
});

test('a requested session log file is honoured once, not pinned', () => {
  assert.match(workbench, /export function LogWorkbench\(\{ visible, sessionId, onDraft, openFileId, onOpenFileConsumed \}\)/);
  assert.match(workbench, /if \(!sessionId \|\| !openFileId\) return;/);
  assert.match(workbench, /\}, \[sessionId, openFileId\]\);/, 'a tab switch alone must not re-open the last requested file');
  assert.match(workbench, /consumed\.current\?\.\(\);/);
  assert.doesNotMatch(workbench, /\}, \[visible, sessionId, openFileId\]\);/);
  // Both callers must clear the request, or asking for the same file twice is a
  // no-op because the prop never changes.
  assert.match(client, /onOpenFileConsumed=\{\(\)=>setOpenFileId\(undefined\)\}/, 'the dshE2E entry clears its request too');
});

test('the auto-applied filter is recorded even without pressing Enter', () => {
  // The E2E filter applies while typing, so leaving the box is the "applied" moment.
  assert.match(viewer, /if \(filters\.query\.trim\(\)\) queryHistory\.record\(filters\.query, filters\.regex, filters\.caseSensitive\);/);
  assert.match(viewer, /onBlur=\{event => \{[^\n]+window\.setTimeout\(\(\) => \{\n\s+setQueryHistoryOpen\(false\); setQuerySelected\(false\);/);
  assert.match(viewer, /data-history-anchor="filter"/);
});

test('history recording reuses the viewer bounded pattern dialect', () => {
  assert.match(history, /import \{ compilePattern \} from '\.\/log-query\.mjs';/);
  assert.match(history, /try \{ compilePattern\(text, \{ regex: Boolean\(regex\), caseSensitive: Boolean\(caseSensitive\) \}\); \}/);
  assert.match(history, /catch \{ return; \}/, 'an unsafe pattern is never recorded');
  assert.match(history, /const unavailable = cause => cause\?\.status === 404 \|\| cause\?\.status === 501;/, 'a dshE2E-only install degrades instead of erroring');
  assert.match(history, /if \(unavailable\(cause\)\) \{ setAvailable\(false\); setEntries\(\[\]\); return; \}/);
});

test('history helpers behave as expected', () => {
  assert.equal(nextCursor(2, 1, 3), 0);
  assert.equal(nextCursor(0, -1, 3), 2);
  assert.deepEqual(filterHistoryEntries([{ query: 'Error:42' }], 'err').map(entry => entry.query), ['Error:42']);
});
