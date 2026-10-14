import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';

// Exercise the actual hook's effects with deterministic browser and React seams.
// This is lifecycle verification, not evidence of real WebCodecs performance.
const built = await build({
  entryPoints: ['vendor/hooks/useHarmonyLiveFrame.ts'], bundle: true, format: 'esm', platform: 'browser', write: false,
  alias: { '@/lib/harmony/request-error': path.resolve('vendor/lib/harmony/request-error.ts'), '@/lib/harmony/media/browser-video-packets': path.resolve('vendor/lib/harmony/media/browser-video-packets.ts') },
  plugins: [{ name: 'react-lifecycle-seam', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'seam' }));
    builder.onLoad({ filter: /.*/, namespace: 'seam' }, () => ({ contents: `
      export const useState = value => globalThis.__harmonyHookTest.useState(value);
      export const useRef = value => globalThis.__harmonyHookTest.useRef(value);
      export const useEffect = (effect, deps) => globalThis.__harmonyHookTest.useEffect(effect, deps);
      export const useCallback = fn => fn;
    `, loader: 'js' }));
  } }],
});
const { useHarmonyLiveFrame } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

function harness(hidden, fetcher) {
  const saved = Object.fromEntries(['document', 'window', 'fetch', '__harmonyHookTest', 'VideoDecoder', 'EncodedVideoChunk'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  const document = { hidden, addEventListener(name, listener) { listeners.set(name, listener); }, removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); } };
  const options = { active: true, enabled: true, serial: 'TEST-PREVIEW', generation: 1, fallbackError: 'unavailable', canvasRef: { current: null } };
  const hooks = [];
  let index = 0;
  let dirty = false;
  let effects = [];
  const seam = {
    useState(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].value, next => {
        const value = typeof next === 'function' ? next(hooks[slot].value) : next;
        if (!Object.is(hooks[slot].value, value)) { hooks[slot].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const slot = index++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useEffect(effect, deps) {
      const slot = index++;
      const previous = hooks[slot];
      if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) {
        effects.push(() => { previous?.cleanup?.(); hooks[slot] = { deps, cleanup: effect() }; });
      }
    },
  };
  Object.assign(globalThis, { document, window: { setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } }, fetch: fetcher, __harmonyHookTest: seam });
  const render = () => {
    index = 0; effects = []; dirty = false;
    const value = useHarmonyLiveFrame(options);
    for (const effect of effects) effect();
    return value;
  };
  return {
    options, timers,
    flush() { let value; for (let attempts = 0; attempts < 10; attempts++) { value = render(); if (!dirty) return value; } throw Error('Hook did not settle'); },
    visibility(value) { document.hidden = value; listeners.get('visibilitychange')?.(); },
    async dispose() {
      for (const hook of hooks) hook?.cleanup?.();
      await settle();
      assert.equal(timers.size, 0);
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

function pendingFetch(requests) {
  return (url, { signal }) => {
    requests.push({ url, signal });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
  };
}

async function settle() { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); }

test('a hidden initial page opens no preview; visibility resumes only the preview endpoint', async () => {
  const requests = [];
  const h = harness(true, pendingFetch(requests));
  try {
    assert.equal(h.flush().status, 'idle');
    assert.equal(requests.length, 0);
    h.visibility(false); h.flush();
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^\/api\/harmony\/video\?/);
    h.visibility(true);
    assert.equal(requests[0].signal.aborted, true, 'hidden pages immediately abort their own preview request');
    h.flush(); await settle();
    assert.equal(requests.length, 1);
    h.visibility(false); h.flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].signal.aborted, false);
    assert.ok(requests.every(request => request.url.startsWith('/api/harmony/video?')));
  } finally { await h.dispose(); }
});

test('a batched hide/show still replaces the cancelled preview connection', async () => {
  const requests = [];
  const h = harness(false, pendingFetch(requests));
  try {
    h.flush();
    h.visibility(true); h.visibility(false); h.flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, false);
  } finally { await h.dispose(); }
});

function packet(type, payload) {
  const result = new Uint8Array(8 + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, type, false); view.setUint32(4, payload.length, false); result.set(payload, 8);
  return result;
}

test('video uses an opaque cached canvas, five-second static geometry probes, and releases decoder resources when hidden', async () => {
  let closedFrames = 0;
  let closedDecoders = 0;
  let cancelledStreams = 0;
  const contexts = [];
  const paints = [];
  const config = new Uint8Array(24);
  const view = new DataView(config.buffer);
  view.setUint32(1, 100, false); view.setUint32(5, 200, false); view.setUint32(9, 30, false);
  view.setUint16(13, 4, false); config.set([0x67, 0x42, 0xe0, 0x1f], 15);
  view.setUint16(19, 2, false); config.set([0x68, 0], 21); config[23] = 1;
  const picture = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0x65, 1]);
  const h = harness(false, async url => url.startsWith('/api/harmony/geometry?')
    ? { ok: true, json: async () => ({ geometry: { frameWidth: 100, frameHeight: 200, geometryId: 'test-geometry' } }) }
    : { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(packet(2, config)); controller.enqueue(packet(3, picture)); }, cancel() { cancelledStreams += 1; } }) });
  class Decoder {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; }
    configure() { this.state = 'configured'; }
    decode() { this.callbacks.output({ displayWidth: 100, displayHeight: 200, close() { closedFrames += 1; } }); }
    close() { this.state = 'closed'; closedDecoders += 1; }
  }
  Object.assign(globalThis, { VideoDecoder: Decoder, EncodedVideoChunk: class { constructor(options) { Object.assign(this, options); } } });
  globalThis.window.VideoDecoder = Decoder;
  const context = { clearRect() {}, drawImage() { paints.push(1); } };
  h.options.canvasRef.current = { width: 0, height: 0, getContext(kind, options) { contexts.push({ kind, options }); return context; } };
  try {
    h.flush(); await settle();
    assert.equal(paints.length, 1);
    assert.equal(closedFrames, 1);
    assert.deepEqual(contexts, [{ kind: '2d', options: { alpha: false } }]);
    assert.ok([...h.timers.values()].some(timer => timer.delay === 5000));
    assert.equal(h.flush().frame.geometryId, 'test-geometry');
    h.visibility(true); h.flush(); await settle();
    assert.equal(closedDecoders, 1);
    assert.equal(cancelledStreams, 1);
    assert.equal(h.flush().frame.geometryId, undefined);
  } finally { await h.dispose(); }
});
