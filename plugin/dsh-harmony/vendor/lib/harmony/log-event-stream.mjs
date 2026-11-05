import { Buffer } from 'node:buffer';

export const LOG_EVENT_LIMITS = Object.freeze({
  pendingRows: 20_000, pendingBytes: 16 * 1024 * 1024,
  batchRows: 500, batchBytes: 256 * 1024, streamBytes: 512 * 1024, delayMs: 50,
});
const encoder = new TextEncoder();
const ENVELOPE_BYTES = 128;

/** Serialized ring: bounded payload and O(1) insertion/removal. */
export class LogEventQueue {
  constructor() {
    this.slots = new Array(LOG_EVENT_LIMITS.pendingRows);
    this.head = 0; this.length = 0; this.memoryBytes = 0; this.wireBytes = 0; this.dropped = 0;
  }
  get pending() { return this.length > 0 || this.dropped > 0; }
  get ready() { return this.length >= LOG_EVENT_LIMITS.batchRows || this.wireBytes >= LOG_EVENT_LIMITS.batchBytes - ENVELOPE_BYTES; }
  push(entry) {
    const json = JSON.stringify(entry);
    const wireBytes = Buffer.byteLength(json, 'utf8') + 1;
    // UTF-16 text plus slot allowance; this is not a total V8 heap/RSS limit.
    const memoryBytes = 2 * json.length + 64;
    if (memoryBytes > LOG_EVENT_LIMITS.pendingBytes) { this.dropped++; return; }
    while (this.length && (this.length === LOG_EVENT_LIMITS.pendingRows || this.memoryBytes + memoryBytes > LOG_EVENT_LIMITS.pendingBytes)) {
      this.shift(); this.dropped++;
    }
    this.slots[(this.head + this.length) % this.slots.length] = { json, wireBytes, memoryBytes };
    this.length++; this.memoryBytes += memoryBytes; this.wireBytes += wireBytes;
  }
  shift() {
    const row = this.slots[this.head]; this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.slots.length; this.length--;
    this.memoryBytes -= row.memoryBytes; this.wireBytes -= row.wireBytes;
    return row;
  }
  takeBatch() {
    if (!this.pending) return undefined;
    const rows = []; let bytes = ENVELOPE_BYTES;
    while (this.length && rows.length < LOG_EVENT_LIMITS.batchRows) {
      const row = this.slots[this.head];
      // Permit one oversized row rather than truncating it to the batch target.
      if (rows.length && bytes + row.wireBytes > LOG_EVENT_LIMITS.batchBytes) break;
      rows.push(this.shift().json); bytes += row.wireBytes;
    }
    const dropped = this.dropped; this.dropped = 0;
    return encoder.encode(`event: logs\ndata: {"type":"logs","entries":[${rows.join(',')}],"dropped":${dropped}}\n\n`);
  }
  clear() { while (this.length) this.shift(); this.dropped = 0; }
}

/**
 * Keep draining HDC; browser backpressure only bounds preview data.
 * @param {(onEntries: (entries: import('./types').HarmonyLogEntry[]) => void, signal: AbortSignal) => Promise<void>} subscribe
 * @param {AbortSignal} signal
 */
export function createLogEventStream(subscribe, signal) {
  const queue = new LogEventQueue(), abort = new AbortController();
  let controller, closed = false, ended = false, failure;
  let delay, immediate, heartbeat, forceScheduled = false;
  const writable = () => !closed && (controller.desiredSize ?? 0) > 0;
  const control = event => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(delay); clearImmediate(immediate); clearInterval(heartbeat);
    signal.removeEventListener('abort', cleanup); abort.abort(); queue.clear();
    try { controller.close(); } catch { /* Reader already cancelled. */ }
  };
  const schedule = (force = false) => {
    if (closed) return;
    forceScheduled ||= force;
    if (immediate !== undefined) return;
    immediate = setImmediate(() => {
      immediate = undefined;
      const force = forceScheduled; forceScheduled = false; pump(force);
    });
  };
  const armDelay = () => {
    if (closed || ended || delay !== undefined || !queue.pending) return;
    delay = setTimeout(() => { delay = undefined; pump(true); }, LOG_EVENT_LIMITS.delayMs);
  };
  const pump = (force = false) => {
    if (!writable()) return;
    try {
      if (queue.pending && (force || ended || queue.ready)) {
        clearTimeout(delay); delay = undefined; controller.enqueue(queue.takeBatch());
      }
      if (ended && !queue.pending) {
        if (failure) {
          if (!writable()) return;
          control({ type: 'error', message: failure.message });
        }
        cleanup();
      } else if (queue.pending) {
        // One batch per event-loop turn; a full stream resumes via pull().
        if (writable() && (force || ended || queue.ready)) schedule(force);
        else armDelay();
      }
    } catch { cleanup(); }
  };
  return new ReadableStream({
    start(value) {
      controller = value;
      signal.addEventListener('abort', cleanup, { once: true });
      if (signal.aborted) { cleanup(); return; }
      control({ type: 'connected' });
      heartbeat = setInterval(() => {
        if (writable() && !queue.pending && !ended) {
          try { control({ type: 'heartbeat' }); } catch { cleanup(); }
        }
      }, 15_000);
      void Promise.resolve().then(() => {
        if (closed) return;
        return subscribe(entries => {
          if (closed || ended) return;
          let sent = 0;
          for (const entry of entries) {
            queue.push(entry);
            // Send before a large callback fills the ring, with bounded sync work.
            if (sent < 2 && queue.ready && writable()) { pump(); sent++; }
          }
          if (queue.ready && writable()) schedule(); else armDelay();
        }, abort.signal);
      }).catch(error => { failure = error instanceof Error ? error : new Error(String(error)); })
        .finally(() => {
          if (closed) return;
          ended = true; clearTimeout(delay); delay = undefined; clearInterval(heartbeat); schedule(true);
        });
    },
    pull() { schedule(true); },
    cancel() { cleanup(); },
  }, { highWaterMark: LOG_EVENT_LIMITS.streamBytes, size: chunk => chunk.byteLength });
}
