import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['vendor/lib/harmony/media/browser-video-packets.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
const { consumeHarmonyVideoPackets, MAX_HARMONY_VIDEO_PACKET_BYTES } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

function packet(type, payload = []) {
  const result = new Uint8Array(8 + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, type, false);
  view.setUint32(4, payload.length, false);
  result.set(payload, 8);
  return result;
}

function stream(chunks) {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
}

async function consume(chunks, options = {}) {
  const reader = stream(chunks).getReader();
  const received = [];
  try { await consumeHarmonyVideoPackets(reader, (type, payload) => { received.push({ type, payload }); }, options); }
  finally { await reader.cancel(); reader.releaseLock(); }
  return received;
}

test('a complete continuous payload is forwarded without copying its network buffer', async () => {
  const bytes = packet(3, [1, 2, 3, 4]);
  const [{ type, payload }] = await consume([bytes]);
  assert.equal(type, 3);
  assert.equal(payload.buffer, bytes.buffer);
  assert.equal(payload.byteOffset, bytes.byteOffset + 8);
  assert.deepEqual([...payload], [1, 2, 3, 4]);
});

test('a header ending at a chunk boundary still allows a zero-copy continuous payload', async () => {
  const bytes = packet(3, [11, 12, 13]);
  const payloadChunk = bytes.slice(8);
  const [received] = await consume([bytes.slice(0, 3), bytes.slice(3, 8), payloadChunk]);
  assert.equal(received.payload.buffer, payloadChunk.buffer);
});

test('byte-by-byte fragmentation reconstructs headers and large payloads without a growing concatenation', async () => {
  const original = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
  const bytes = packet(3, original);
  const chunks = [...bytes].map(byte => Uint8Array.of(byte));
  const [received] = await consume(chunks);
  assert.deepEqual(received.payload, original);
  assert.ok(chunks.every(chunk => received.payload.buffer !== chunk.buffer));
});

test('several packets, empty packets, and a fragmented next header preserve packet boundaries', async () => {
  const bytes = new Uint8Array([...packet(2, [7, 8]), ...packet(99), ...packet(3, [21, 22, 23])]);
  const received = await consume([new Uint8Array(), bytes.slice(0, 15), bytes.slice(15, 19), bytes.slice(19)]);
  assert.deepEqual(received.map(({ type, payload }) => [type, [...payload]]), [[2, [7, 8]], [99, []], [3, [21, 22, 23]]]);
});

test('the strict 8 MiB payload boundary is accepted, while larger announced packets fail before buffering', async () => {
  assert.equal(MAX_HARMONY_VIDEO_PACKET_BYTES, 8 * 1024 * 1024);
  const bytes = packet(3, new Uint8Array(MAX_HARMONY_VIDEO_PACKET_BYTES));
  let length;
  const reader = stream([bytes]).getReader();
  try { await consumeHarmonyVideoPackets(reader, (_type, payload) => { length = payload.length; }); }
  finally { reader.releaseLock(); }
  assert.equal(length, MAX_HARMONY_VIDEO_PACKET_BYTES);
  const oversized = packet(3);
  new DataView(oversized.buffer).setUint32(4, MAX_HARMONY_VIDEO_PACKET_BYTES + 1, false);
  await assert.rejects(consume([oversized]), /packet is too large/);
});

test('total pending bytes and incoming network chunks have a separate bound', async () => {
  const bytes = packet(3, new Uint8Array(16));
  await assert.rejects(consume([bytes], { maxPacketBytes: 16, maxBufferedBytes: 23 }), /buffer limit/);
  // Nine already-pending bytes plus this sixteen-byte chunk exceed the queue bound.
  await assert.rejects(consume([bytes.slice(0, 9), new Uint8Array(16)], { maxPacketBytes: 16, maxBufferedBytes: 24 }), /buffer limit/);
  await assert.rejects(consume([], { maxPacketBytes: -1 }), /buffer limits/);
});

test('EOF never silently accepts a partial header or a partial payload', async () => {
  await assert.rejects(consume([Uint8Array.of(0, 0, 0)]), /truncated/);
  await assert.rejects(consume([packet(3, [1, 2, 3]).slice(0, 9)]), /truncated/);
  await assert.rejects(consume([packet(3, [1, 2, 3]).slice(0, 8)]), /truncated/);
});

test('awaited packet consumers prevent additional source reads during decoder backpressure', async () => {
  let reads = 0;
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const chunks = [packet(3, [1]), packet(3, [2])];
  const reader = { read: async () => { reads += 1; return chunks.length ? { value: chunks.shift(), done: false } : { done: true }; }, cancel: async () => {} };
  const received = [];
  const running = consumeHarmonyVideoPackets(reader, async (_type, payload) => {
    received.push(payload[0]);
    if (received.length === 1) { started(); await gate; }
  });
  await ready;
  assert.equal(reads, 1);
  release();
  await running;
  assert.deepEqual(received, [1, 2]);
});

test('abort cancels a pending read and does not dispatch a stale packet', async () => {
  let cancelled = 0;
  let packets = 0;
  const reader = new ReadableStream({ cancel() { cancelled += 1; } }).getReader();
  const controller = new AbortController();
  const running = consumeHarmonyVideoPackets(reader, () => { packets += 1; }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, error => error.name === 'AbortError');
  assert.equal(cancelled, 1);
  assert.equal(packets, 0);
  reader.releaseLock();
});
