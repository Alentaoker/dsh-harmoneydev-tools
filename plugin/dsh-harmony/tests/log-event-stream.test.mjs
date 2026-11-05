import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createLogEventStream, LogEventQueue, LOG_EVENT_LIMITS as limits } from '../vendor/lib/harmony/log-event-stream.mjs';

const row = (id, text = 'log') => ({ level: 'info', pid: 1, raw: `${id}: ${text}`, message: text });
const parse = bytes => JSON.parse(new TextDecoder().decode(bytes).split('\ndata: ')[1].trim());
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Log stream stalled')), 3000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t) {
  const abort = new AbortController();
  let emit, finish, fail, sourceSignal, begin;
  const started = new Promise(resolve => { begin = resolve; });
  const stream = createLogEventStream((onEntries, signal) => {
    emit = onEntries; sourceSignal = signal;
    const lifetime = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    signal.addEventListener('abort', () => finish(), { once: true });
    begin(); return lifetime;
  }, abort.signal);
  const reader = stream.getReader();
  t.after(() => abort.abort());
  await started;
  assert.equal(parse((await reader.read()).value).type, 'connected');
  return { reader, emit: entries => emit(entries), finish: () => finish(), fail: error => fail(error), sourceSignal, abort };
}
async function collect(reader) {
  const events = [];
  for (;;) {
    const next = await within(reader.read());
    if (next.done) return events;
    events.push(parse(next.value));
  }
}
const received = events => events.flatMap(event => event.entries ?? []);
const dropped = events => events.reduce((sum, event) => sum + (event.dropped ?? 0), 0);
const ids = rows => rows.map(entry => Number(entry.raw.split(':')[0]));

// These tests import plain JS directly: no npm hooks, esbuild or device access.
test('one callback with 12000 rows preserves every row in order', async t => {
  const f = await fixture(t), entries = Array.from({ length: 12000 }, (_, id) => row(id));
  f.emit(entries); f.finish();
  const events = await collect(f.reader);
  assert.deepEqual(received(events), entries); assert.equal(dropped(events), 0);
  assert.ok(events.filter(e => e.type === 'logs').every(e => e.entries.length <= limits.batchRows));
});

test('low-volume logs flush without waiting for another source callback', async t => {
  const f = await fixture(t);
  await turn(); // Let the initial pull settle before the sparse row arrives.
  f.emit([row(1)]);
  const next = parse((await within(f.reader.read())).value);
  assert.equal(next.type, 'logs'); assert.deepEqual(next.entries, [row(1)]);
});

test('threshold sends immediately rather than waiting for the 50ms timer', async t => {
  const f = await fixture(t);
  f.emit(Array.from({ length: limits.batchRows }, (_, id) => row(id)));
  let delivered = false;
  const read = f.reader.read().then(next => { delivered = true; return next; });
  await turn();
  assert.equal(delivered, true);
  assert.equal(parse((await read).value).entries.length, limits.batchRows);
});

test('slow reader resumes on pull and source completion drains the queued tail', async t => {
  const f = await fixture(t), entries = Array.from({ length: 6000 }, (_, id) => row(id, 'x'.repeat(512)));
  f.emit(entries); await turn(); f.finish(); await turn();
  const events = await collect(f.reader);
  assert.deepEqual(received(events), entries); assert.equal(dropped(events), 0);
  assert.equal(f.sourceSignal.aborted, true);
});

test('overload remains bounded and reports the exact number of evicted rows once', async t => {
  const f = await fixture(t), count = 35000;
  f.emit(Array.from({ length: count }, (_, id) => row(id))); await turn(); f.finish();
  const events = await collect(f.reader), rows = received(events), sequence = ids(rows);
  assert.ok(dropped(events) > 0);
  assert.equal(rows.length + dropped(events), count);
  assert.equal(new Set(sequence).size, rows.length);
  assert.deepEqual(sequence, sequence.toSorted ? sequence.toSorted((a, b) => a - b) : [...sequence].sort((a, b) => a - b));
  assert.equal(sequence.at(-1), count - 1);
});

test('ring obeys both row and memory budgets and releases every retained slot', () => {
  const queue = new LogEventQueue();
  for (let id = 0; id < 25000; id++) {
    queue.push(row(id));
    assert.ok(queue.length <= limits.pendingRows); assert.ok(queue.memoryBytes <= limits.pendingBytes);
  }
  assert.equal(queue.length, 20000); assert.equal(queue.dropped, 5000);
  queue.clear();
  for (let id = 0; id < 2000; id++) {
    queue.push(row(id, 'x'.repeat(8192)));
    assert.ok(queue.memoryBytes <= limits.pendingBytes);
  }
  assert.ok(queue.length < 2000); assert.ok(queue.dropped > 0);
  queue.clear();
  assert.equal(queue.length, 0); assert.equal(queue.memoryBytes, 0); assert.equal(queue.wireBytes, 0);
  assert.ok(queue.slots.every(slot => slot === undefined));
});

test('wire batch cap counts UTF-8 and escaping, preserving the exact payload', () => {
  const queue = new LogEventQueue(), entries = Array.from({ length: 500 }, (_, id) => row(id, '\u4e2d\u6587\ud83d\ude00\n\"\\'.repeat(100)));
  for (const entry of entries) queue.push(entry);
  const rows = [];
  while (queue.pending) {
    const bytes = queue.takeBatch();
    assert.ok(bytes.byteLength <= limits.batchBytes);
    rows.push(...parse(bytes).entries);
  }
  assert.deepEqual(rows, entries);
});

test('single long row can exceed the batch target without truncation or loss', () => {
  const queue = new LogEventQueue(), entry = row(1, 'x'.repeat(200000));
  queue.push(entry);
  const bytes = queue.takeBatch();
  assert.ok(bytes.byteLength > limits.batchBytes);
  assert.deepEqual(parse(bytes).entries, [entry]); assert.equal(parse(bytes).dropped, 0);
});

test('a row beyond the entire queue budget still produces a drop report', async t => {
  const f = await fixture(t);
  f.emit([row(1, 'x'.repeat(limits.pendingBytes / 2))]); f.finish();
  const events = await collect(f.reader);
  assert.equal(received(events).length, 0); assert.equal(dropped(events), 1);
});

test('source failure drains queued logs before the final error event', async t => {
  const f = await fixture(t), entries = Array.from({ length: 6000 }, (_, id) => row(id, 'x'.repeat(512)));
  f.emit(entries); f.fail(Error('HDC disconnected')); await turn();
  const events = await collect(f.reader);
  assert.deepEqual(received(events), entries);
  assert.deepEqual(events.at(-1), { type: 'error', message: 'HDC disconnected' });
});

test('cancel and request abort stop the source without reopening it', async t => {
  const f = await fixture(t);
  f.emit(Array.from({ length: 2000 }, (_, id) => row(id)));
  await f.reader.cancel(); assert.equal(f.sourceSignal.aborted, true);
  assert.doesNotThrow(() => f.emit([row(9999)]));
  const g = await fixture(t); g.abort.abort();
  assert.equal(g.sourceSignal.aborted, true); assert.equal((await g.reader.read()).done, true);
});

test('already aborted request never starts a collector', async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  const stream = createLogEventStream(async () => { calls++; }, abort.signal);
  assert.equal((await stream.getReader().read()).done, true); assert.equal(calls, 0);
});


test('sustained input at 1000, 5000 and 10000 rows/sec stays ordered with zero drops', async t => {
  for (const rate of [1000, 5000, 10000]) {
    await t.test(`${rate} rows/sec`, async t => {
      const f = await fixture(t), eventsPromise = collect(f.reader);
      const batchSize = rate / 20, ticks = 10;
      for (let tick = 0; tick < ticks; tick++) {
        f.emit(Array.from({ length: batchSize }, (_, offset) => row(tick * batchSize + offset, 'x'.repeat(300))));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      f.finish();
      const events = await eventsPromise, sequence = ids(received(events));
      assert.equal(dropped(events), 0);
      assert.deepEqual(sequence, Array.from({ length: batchSize * ticks }, (_, id) => id));
    });
  }
});
