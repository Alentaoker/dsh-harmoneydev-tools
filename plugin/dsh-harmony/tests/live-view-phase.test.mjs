import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['vendor/lib/harmony/observation/live-view-phase.ts'], bundle: true, format: 'esm', write: false });
const {
  resolveLiveViewPhase, liveViewPolicy, shouldProbeScreenState, unlockedSince,
  COMPATIBLE_SCREENSHOT_INTERVAL_MS, LOCKED_SCREENSHOT_INTERVAL_MS,
} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

const base = { enabled: true, paused: false, online: true, mode: 'video', status: 'loading', videoBlocked: false };

test('a locked or sleeping phone is its own waiting phase, never a stream failure', () => {
  assert.equal(resolveLiveViewPhase({ ...base, status: 'error', locked: true }), 'waiting-unlock');
  assert.equal(resolveLiveViewPhase({ ...base, awake: false, locked: false }), 'waiting-unlock');
  assert.equal(resolveLiveViewPhase({ ...base, awake: true, locked: false }), 'connecting');
});

test('an unknown lock state does not block a stream attempt', () => {
  assert.equal(resolveLiveViewPhase({ ...base, awake: true }), 'connecting');
  assert.equal(resolveLiveViewPhase({ ...base }), 'connecting');
});

test('phases map to their real channels', () => {
  assert.equal(resolveLiveViewPhase({ ...base, status: 'live' }), 'live');
  assert.equal(resolveLiveViewPhase({ ...base, mode: 'frames', status: 'live' }), 'compatible');
  assert.equal(resolveLiveViewPhase({ ...base, mode: 'frames', status: 'error' }), 'recovering');
  assert.equal(resolveLiveViewPhase({ ...base, videoBlocked: true }), 'busy');
  assert.equal(resolveLiveViewPhase({ ...base, online: false }), 'offline');
  assert.equal(resolveLiveViewPhase({ ...base, enabled: false }), 'offline');
  assert.equal(resolveLiveViewPhase({ ...base, paused: true }), 'paused');
});

test('screenshot fallback costs 1～2 per second and drops to one per two seconds while locked', () => {
  assert.equal(liveViewPolicy('compatible').screenshotIntervalMs, COMPATIBLE_SCREENSHOT_INTERVAL_MS);
  assert.ok(COMPATIBLE_SCREENSHOT_INTERVAL_MS >= 500 && COMPATIBLE_SCREENSHOT_INTERVAL_MS <= 1000);
  assert.equal(liveViewPolicy('waiting-unlock').screenshotIntervalMs, LOCKED_SCREENSHOT_INTERVAL_MS);
  assert.ok(LOCKED_SCREENSHOT_INTERVAL_MS >= 1_000);
  assert.ok(liveViewPolicy('waiting-unlock').screenshotIntervalMs > liveViewPolicy('compatible').screenshotIntervalMs);
});

test('a locked screen waits about two seconds between merged checks', () => {
  assert.equal(liveViewPolicy('waiting-unlock').screenProbeIntervalMs, 2_000);
  assert.equal(liveViewPolicy('waiting-unlock').videoAttemptAllowed, false);
  assert.equal(liveViewPolicy('live').videoAttemptAllowed, true);
});

test('the old 30~120 second backoff is never used for the locked state', () => {
  assert.ok(liveViewPolicy('waiting-unlock').reconnectDelayMs <= 2_000);
  assert.equal(liveViewPolicy('busy').reconnectDelayMs, 10_000);
});

test('lock probing is disabled only where there is nothing to observe', () => {
  assert.equal(shouldProbeScreenState('offline'), false);
  assert.equal(shouldProbeScreenState('paused'), false);
  assert.equal(shouldProbeScreenState('waiting-unlock'), true);
  assert.equal(shouldProbeScreenState('compatible'), true);
});

test('unlocking is recognised as the end of the waiting phase only', () => {
  assert.equal(unlockedSince('waiting-unlock', 'connecting'), true);
  assert.equal(unlockedSince('waiting-unlock', 'waiting-unlock'), false);
  assert.equal(unlockedSince('waiting-unlock', 'offline'), false);
  assert.equal(unlockedSince('live', 'connecting'), false);
});
