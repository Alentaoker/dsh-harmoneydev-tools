import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['vendor/lib/harmony/log-search-history.ts'], bundle: true, format: 'esm', platform: 'node', packages: 'external', write: false });
const history = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

test('the newest search comes first and duplicates collapse', () => {
  let entries = [];
  entries = history.recordLogSearch(entries, { query: 'alpha', regex: false, caseSensitive: false, now: 1_000 });
  entries = history.recordLogSearch(entries, { query: 'beta', regex: false, caseSensitive: false, now: 2_000 });
  entries = history.recordLogSearch(entries, { query: 'alpha', regex: false, caseSensitive: false, now: 3_000 });
  assert.deepEqual(entries.map(entry => entry.query), ['alpha', 'beta']);
  assert.equal(entries[0].usedAt, new Date(3_000).toISOString());
});

test('the pattern and its flags are stored separately', () => {
  let entries = [];
  entries = history.recordLogSearch(entries, { query: 'Error', regex: false, caseSensitive: false, now: 1 });
  entries = history.recordLogSearch(entries, { query: 'Error', regex: true, caseSensitive: true, now: 2 });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => [entry.regex, entry.caseSensitive]), [[true, true], [false, false]]);
});

test('find and filter keep thirty entries each', () => {
  let entries = [];
  for (let index = 0; index < 40; index += 1) entries = history.recordLogSearch(entries, { query: `term-${index}`, regex: false, caseSensitive: false, now: index });
  assert.equal(entries.length, history.LOG_SEARCH_HISTORY_LIMIT);
  assert.equal(entries[0].query, 'term-39');
  assert.equal(entries.at(-1).query, 'term-10');
});

test('empty text and invalid regular expressions are never recorded', () => {
  let entries = history.recordLogSearch([], { query: '   ', regex: false, caseSensitive: false, now: 1 });
  assert.equal(entries.length, 0);
  entries = history.recordLogSearch([], { query: '([unclosed', regex: true, caseSensitive: false, now: 1 });
  assert.equal(entries.length, 0);
  entries = history.recordLogSearch([], { query: '([unclosed', regex: false, caseSensitive: false, now: 1 });
  assert.equal(entries.length, 1, 'the same text is valid as a literal search');
});

test('one entry or one whole list can be removed', () => {
  let entries = [];
  entries = history.recordLogSearch(entries, { query: 'one', regex: false, caseSensitive: false, now: 1 });
  entries = history.recordLogSearch(entries, { query: 'two', regex: true, caseSensitive: true, now: 2 });
  entries = history.removeLogSearch(entries, { query: 'one', regex: false, caseSensitive: false });
  assert.deepEqual(entries.map(entry => entry.query), ['two']);
  assert.deepEqual(history.normalizeLogSearchHistory({ find: [], filter: entries }).filter.map(entry => entry.query), ['two']);
});

test('a corrupted file degrades to an empty history instead of failing', () => {
  assert.deepEqual(history.normalizeLogSearchHistory({ find: 'nope', filter: [null, 3, { query: '' }] }), { find: [], filter: [] });
  assert.deepEqual(history.normalizeLogSearchHistory(null), { find: [], filter: [] });
});

test('the store round-trips through the DSH data directory', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-log-history-'));
  const environment = { PI_CODING_AGENT_DIR: root };
  try {
    assert.equal(history.logSearchHistoryPath(environment), path.join(root, 'harmony-log-search-history.json'));
    assert.deepEqual(history.readLogSearchHistory(environment), { find: [], filter: [] }, 'a first run has no file');
    const afterRecord = history.updateLogSearchHistory({ kind: 'filter', action: 'record', query: 'TAG:abc', regex: false, caseSensitive: true }, environment);
    assert.equal(afterRecord.filter.length, 1);
    const reopened = history.readLogSearchHistory(environment);
    assert.deepEqual(reopened.filter.map(entry => [entry.query, entry.caseSensitive]), [['TAG:abc', true]]);
    history.updateLogSearchHistory({ kind: 'filter', action: 'clear' }, environment);
    assert.deepEqual(history.readLogSearchHistory(environment).filter, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
