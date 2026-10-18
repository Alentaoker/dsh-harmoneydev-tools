import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';

// Exercise the actual hook's effects with deterministic browser and React seams.
// This is lifecycle verification, not evidence of real WebCodecs performance.
const built = await build({
  entryPoints: ['vendor/hooks/useHarmonyLiveFrame.ts'], bundle: true, format: 'esm', platform: 'browser', write: false,
  alias: { '@/lib/harmony/request-error': path.resolve('vendor/lib/harmony/request-error.ts'), '@/lib/harmony/media/browser-video-packets': path.resolve('vendor/lib/harmony/media/browser-video-packets.ts'),
    '@/lib/harmony/observation/screen-state': path.resolve('vendor/lib/harmony/observation/screen-state.ts'),
    '@/lib/harmony/observation/live-view-phase': path.resolve('vendor/lib/harmony/observation/live-view-phase.ts'),
    '@/lib/harmony/media/video-backlog': path.resolve('vendor/lib/harmony/media/video-backlog.ts') },
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
  const saved = Object.fromEntries(['document', 'window', 'fetch', '__harmonyHookTest', 'VideoDecoder', 'EncodedVideoChunk', 'performance', 'createImageBitmap'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  let now = 0;
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
  Object.assign(globalThis, { document, performance: { now: () => now }, window: { setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } }, fetch: fetcher, __harmonyHookTest: seam });
  const render = () => {
    index = 0; effects = []; dirty = false;
    const value = useHarmonyLiveFrame(options);
    for (const effect of effects) effect();
    return value;
  };
  return {
    options, timers,
    advance(ms) { now += ms; },
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

function streamConfig(changeDriven = 1) {
  const config = new Uint8Array(24);
  const view = new DataView(config.buffer);
  view.setUint32(1, 100, false); view.setUint32(5, 200, false); view.setUint32(9, 30, false);
  view.setUint16(13, 4, false); config.set([0x67, 0x42, 0xe0, 0x1f], 15);
  view.setUint16(19, 2, false); config.set([0x68, 0], 21); config[23] = changeDriven;
  return config;
}

/** One H.264 access unit: 1 flag byte, 8 timestamp bytes, then the payload. */
function framePacket(key, extraBytes = 0) {
  const payload = new Uint8Array(9 + extraBytes);
  payload[0] = key ? 1 : 0;
  payload[8] = 1;
  if (extraBytes) payload[13] = 0x65;
  return packet(3, payload);
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
    : url.startsWith('/api/harmony/screen-state?')
      ? { ok: true, json: async () => ({ awake: true, locked: false }) }
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

test('external video contention stays identifiable with low-rate preview and retries after release', async () => {
  let videoRequests = 0, frameRequests = 0;
  const h = harness(false, async (url, {signal}) => {
    if (url.startsWith('/api/harmony/video?')) {
      videoRequests += 1;
      if (videoRequests === 1) return {ok:false,status:409,json:async()=>({error:{code:'DEVICE_BUSY',message:'busy',
        details:{reason:'native-video-conflict',source:'deveco',devicePid:51811,extension:'libscreen_casting.z.so',deviceStartTime:'22351072'}}})};
      return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));
    }
    if (url.startsWith('/api/harmony/geometry?')) return {ok:true,json:async()=>({geometry:{frameWidth:100,frameHeight:200,geometryId:'preview'}})};
    if (url.startsWith('/api/harmony/screen-state?')) return {ok:true,json:async()=>({awake:true,locked:false})};
    frameRequests += 1;
    return {ok:true,headers:new Headers({'X-Harmony-Generation':'1','X-Harmony-Revision':'1'}),blob:async()=>new Blob()};
  });
  h.options.chinese = true;
  h.options.canvasRef.current={width:100,height:200,getContext:()=>({drawImage(){},clearRect(){}})};
  globalThis.createImageBitmap=async()=>({width:100,height:200,close(){}});
  try {
    h.flush();await settle();const state=h.flush();
    assert.equal(state.videoBlocked,true);assert.equal(state.mode,'frames');assert.equal(state.status,'live');
    assert.match(state.fallbackReason,/DevEco.*51811/);assert.equal(frameRequests,1);
    assert.deepEqual(state.videoRecovery,{devicePid:51811,extension:'libscreen_casting.z.so',deviceStartTime:'22351072'});
    const entry=[...h.timers].find(([,timer])=>timer.delay===1500);assert.ok(entry,'busy preview uses a 1.5s delay');
    h.advance(11000);h.timers.delete(entry[0]);entry[1].fn();await settle();
    assert.equal(videoRequests,2,'release is probed without a manual refresh');assert.equal(frameRequests,1);
    const probing=h.flush();assert.equal(probing.videoRecovery,undefined);assert.equal(probing.videoBlocked,false);
    assert.doesNotMatch(probing.fallbackReason,/51811/,'a stale PID is cleared during the next probe');
  } finally {await h.dispose();}
});

test('a locked phone waits at a two-second cadence and reconnects as soon as it is unlocked', async () => {
  let locked = true;
  let videoRequests = 0, frameRequests = 0, screenRequests = 0;
  const h = harness(false, async (url, { signal }) => {
    if (url.startsWith('/api/harmony/video?')) {
      videoRequests += 1;
      if (videoRequests === 1) return { ok: false, status: 409, json: async () => ({ error: { code: 'SCREEN_LOCKED', message: 'locked' } }) };
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
    }
    if (url.startsWith('/api/harmony/screen-state?')) { screenRequests += 1; return { ok: true, json: async () => ({ awake: true, locked }) }; }
    if (url.startsWith('/api/harmony/geometry?')) return { ok: true, json: async () => ({ geometry: { frameWidth: 100, frameHeight: 200, geometryId: 'preview' } }) };
    frameRequests += 1;
    return { ok: true, headers: new Headers({ 'X-Harmony-Generation': '1', 'X-Harmony-Revision': '1' }), blob: async () => new Blob() };
  });
  h.options.chinese = true;
  h.options.canvasRef.current = { width: 100, height: 200, getContext: () => ({ drawImage() {}, clearRect() {} }) };
  globalThis.createImageBitmap = async () => ({ width: 100, height: 200, close() {} });
  try {
    h.flush(); await settle();
    const waiting = h.flush();
    assert.equal(videoRequests, 1);
    assert.equal(waiting.phase, 'waiting-unlock', 'a locked screen is a waiting phase, not a stream failure');
    assert.deepEqual(waiting.screen, { awake: true, locked: true });
    assert.equal(waiting.mode, 'frames');
    assert.ok(screenRequests >= 1, 'the lock state is read passively instead of guessing');
    assert.equal(frameRequests, 1, 'the last frame stays visible at a low cadence');
    assert.ok([...h.timers.values()].some(timer => timer.delay === 2000), 'waiting uses about a two-second cadence, not 120ms');

    // Unlock the phone. The next probe notices and the stream is retried without
    // waiting out any exponential backoff; at most one more preview tick passes.
    locked = false;
    for (let round = 0; round < 3 && videoRequests < 2; round += 1) {
      for (const [id, timer] of [...h.timers]) { if (timer.delay === 2000) { h.timers.delete(id); timer.fn(); } }
      await settle();
      h.flush(); await settle();
    }
    assert.equal(videoRequests, 2, 'a confirmed unlock reconnects immediately');
    const resumed = h.flush();
    assert.notEqual(resumed.phase, 'waiting-unlock');
  } finally { await h.dispose(); }
});

test('a backlog stall is bounded: the preview asks for a fresh keyframe instead of freezing', async () => {
  let videoRequests = 0;
  const h = harness(false, async url => {
    if (url.startsWith('/api/harmony/geometry?')) return { ok: true, json: async () => ({ geometry: { frameWidth: 100, frameHeight: 200, geometryId: 'g' } }) };
    if (url.startsWith('/api/harmony/screen-state?')) return { ok: true, json: async () => ({ awake: true, locked: false }) };
    videoRequests += 1;
    return { ok: true, body: new ReadableStream({ start(controller) {
      controller.enqueue(packet(2, streamConfig()));
      // One oversized IDR plus dependent frames, and a decoder that never
      // releases anything: the preview budget is exceeded immediately.
      controller.enqueue(framePacket(true, 1_600_000));
      controller.enqueue(framePacket(false));
      controller.enqueue(framePacket(false));
    } }) };
  });
  class StuckDecoder {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; }
    configure() { this.state = 'configured'; }
    decode() { this.decodeQueueSize += 1; }
    close() { this.state = 'closed'; }
  }
  Object.assign(globalThis, { VideoDecoder: StuckDecoder, EncodedVideoChunk: class { constructor(options) { Object.assign(this, options); } } });
  globalThis.window.VideoDecoder = StuckDecoder;
  h.options.canvasRef.current = { width: 100, height: 200, getContext: () => ({ drawImage() {}, clearRect() {} }) };
  try {
    h.flush(); await settle();
    const stalled = h.flush();
    assert.ok(stalled.metrics.droppedFrames >= 1, 'dependent frames are skipped once the budget is exceeded');
    assert.ok([...h.timers.values()].some(timer => timer.delay === 2000), 'the keyframe wait is bounded by a timer');

    // The screen is now static, so that source will never send an IDR. The
    // bound must produce a new video request instead of a frozen picture.
    for (let round = 0; round < 4 && videoRequests < 2; round += 1) {
      for (const [id, timer] of [...h.timers]) { if (timer.delay === 2000 || timer.delay === 250) { h.timers.delete(id); timer.fn(); } }
      await settle(); h.flush(); await settle();
    }
    assert.equal(videoRequests, 2, 'a stalled backlog reconnects for a fresh keyframe');
    assert.ok(h.flush().metrics.resyncs >= 1, 'the forced resync is reported, not hidden');
  } finally { await h.dispose(); }
});

test('an unlock ends a compatible-preview window instead of waiting out its full budget', async () => {
  let locked = false, videoRequests = 0, frameRequests = 0;
  const h = harness(false, async (url, { signal }) => {
    if (url.startsWith('/api/harmony/video?')) {
      videoRequests += 1;
      if (videoRequests <= 3) return { ok: false, status: 500, json: async () => ({ error: { code: 'COMMAND_FAILED', message: 'stream failed' } }) };
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
    }
    if (url.startsWith('/api/harmony/screen-state?')) return { ok: true, json: async () => ({ awake: true, locked }) };
    if (url.startsWith('/api/harmony/geometry?')) return { ok: true, json: async () => ({ geometry: { frameWidth: 100, frameHeight: 200, geometryId: 'preview' } }) };
    frameRequests += 1;
    return { ok: true, headers: new Headers({ 'X-Harmony-Generation': '1', 'X-Harmony-Revision': '1' }), blob: async () => new Blob() };
  });
  h.options.chinese = true;
  h.options.canvasRef.current = { width: 100, height: 200, getContext: () => ({ drawImage() {}, clearRect() {} }) };
  globalThis.createImageBitmap = async () => ({ width: 100, height: 200, close() {} });
  try {
    // Three plain failures land on the compatible preview, which previously had
    // no exit condition other than its own 30～120 s budget.
    const fire = maxDelay => { let fired = 0; for (const [id, timer] of [...h.timers]) { if (timer.delay <= maxDelay) { h.timers.delete(id); timer.fn(); fired += 1; } } return fired; };
    for (let round = 0; round < 12 && videoRequests < 3; round += 1) { fire(1200); await settle(); h.flush(); await settle(); }
    assert.equal(videoRequests, 3);
    assert.equal(h.flush().mode, 'frames');
    const framesBefore = frameRequests;

    // The phone locks, then the person unlocks it. The probe notices both.
    locked = true;
    for (let round = 0; round < 4; round += 1) { fire(4000); await settle(); h.flush(); await settle(); }
    assert.equal(h.flush().phase, 'waiting-unlock', 'a lock during the compatible window is its own phase');

    locked = false;
    for (let round = 0; round < 6 && videoRequests < 4; round += 1) { fire(4000); await settle(); h.flush(); await settle(); }
    assert.equal(videoRequests, 4, 'a confirmed unlock retries the live channel inside the same window');
    assert.ok(frameRequests > framesBefore, 'the compatible preview kept the screen usable while waiting');
  } finally { await h.dispose(); }
});