import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/**
 * The canonical rules live in dshE2E and are shared by both log views. A local
 * fallback exists for a standalone build of this plugin; both are compared on the
 * same case table so they cannot drift apart.
 */
async function loadCanonical() {
  const built = await build({ entryPoints: ['../dsh-e2e/src/log-search-menu.mjs'], bundle: true, format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
}
async function loadFallback() {
  const built = await build({ entryPoints: ['src/log-search-menu-unpaired.ts'], bundle: true, format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
}

const canonical = await loadCanonical();
const fallback = await loadFallback();
const { historyKeyAction, isComposingKey, nextCursor, filterHistoryEntries } = canonical;

const open = { open: true, cursor: 0, count: 3, selected: true };
const browsing = { ...open, selected: false };

test('Enter never turns freshly typed text into an old history entry', () => {
  assert.equal(historyKeyAction({ key: 'Enter' }, browsing), null);
  assert.equal(historyKeyAction({ key: 'Enter' }, open), 'apply');
  assert.equal(historyKeyAction({ key: 'Enter' }, { ...open, count: 0 }), null, 'an empty history cannot be applied');
  assert.equal(historyKeyAction({ key: 'Enter', shiftKey: true }, open), null, 'Shift+Enter stays a previous match');
});

test('an IME candidate confirmation is never treated as a shortcut', () => {
  assert.equal(historyKeyAction({ key: 'Enter', isComposing: true }, open), null);
  assert.equal(historyKeyAction({ key: 'Enter', keyCode: 229 }, open), null);
  assert.equal(historyKeyAction({ key: 'Escape', isComposing: true }, open), null);
  assert.equal(isComposingKey({ isComposing: true }), true);
  assert.equal(isComposingKey({ keyCode: 229 }), true);
  assert.equal(isComposingKey({ keyCode: 13 }), false);
});

test('a React synthetic event is checked through nativeEvent as well', () => {
  // React does not copy isComposing onto its wrapper, so a composition that only
  // marks the native event must still suppress the shortcut.
  assert.equal(isComposingKey({ key: 'Enter', nativeEvent: { isComposing: true } }), true);
  assert.equal(isComposingKey({ key: 'Enter', nativeEvent: { keyCode: 229 } }), true);
  assert.equal(historyKeyAction({ key: 'Enter', nativeEvent: { isComposing: true } }, open), null);
  assert.equal(historyKeyAction({ key: 'Enter', nativeEvent: { keyCode: 229 } }, open), null);
  assert.equal(historyKeyAction({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }, open), 'apply');
});

test('Escape closes the history before anything else', () => {
  assert.equal(historyKeyAction({ key: 'Escape' }, open), 'close');
  assert.equal(historyKeyAction({ key: 'Escape' }, { ...open, open: false }), null, 'a closed history never eats Escape');
});

test('arrow keys move inside the history only while it is open', () => {
  assert.equal(historyKeyAction({ key: 'ArrowDown' }, open), 'down');
  assert.equal(historyKeyAction({ key: 'ArrowUp' }, open), 'up');
  assert.equal(historyKeyAction({ key: 'ArrowDown' }, { ...open, open: false }), null);
});

test('the cursor wraps in both directions and survives an empty list', () => {
  assert.equal(nextCursor(0, 1, 3), 1);
  assert.equal(nextCursor(2, 1, 3), 0);
  assert.equal(nextCursor(0, -1, 3), 2);
  assert.equal(nextCursor(5, 1, 3), 0);
  assert.equal(nextCursor(2, 1, 0), 0);
});

test('typing narrows the visible history case-insensitively', () => {
  const entries = [{ query: 'Error:42', regex: false, caseSensitive: false }, { query: 'warn', regex: false, caseSensitive: false }];
  assert.deepEqual(filterHistoryEntries(entries, 'err').map(entry => entry.query), ['Error:42']);
  assert.equal(filterHistoryEntries(entries, '   ').length, 2, 'an empty box shows every recent entry');
  assert.deepEqual(filterHistoryEntries(entries, 'zzz'), []);
});

test('the standalone fallback matches the canonical rules case for case', () => {
  const events = [
    { key: 'Enter' }, { key: 'Enter', shiftKey: true }, { key: 'Escape' }, { key: 'ArrowUp' }, { key: 'ArrowDown' },
    { key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Enter', nativeEvent: { isComposing: true } },
    { key: 'Enter', nativeEvent: { keyCode: 229 } }, { key: 'Escape', nativeEvent: { isComposing: true } }, { key: 'a' },
  ];
  const states = [open, browsing, { ...open, open: false }, { ...open, count: 0 }, { ...open, cursor: 2 }];
  for (const event of events) for (const state of states) {
    assert.equal(fallback.historyKeyAction(event, state), historyKeyAction(event, state), JSON.stringify({ event, state }));
  }
  for (const event of events) assert.equal(fallback.isComposingKey(event), isComposingKey(event), JSON.stringify(event));
  for (const [current, delta, count] of [[0, 1, 3], [2, 1, 3], [0, -1, 3], [5, 1, 3], [2, 1, 0]]) {
    assert.equal(fallback.nextCursor(current, delta, count), nextCursor(current, delta, count));
  }
  const entries = [{ query: 'Error:42' }, { query: 'warn' }];
  for (const value of ['', '   ', 'err', 'zzz']) {
    assert.deepEqual(fallback.filterHistoryEntries(entries, value), filterHistoryEntries(entries, value));
  }
});
