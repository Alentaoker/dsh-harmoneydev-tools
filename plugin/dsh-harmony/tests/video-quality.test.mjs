import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['vendor/lib/harmony/media/video-quality.ts'], bundle: true, format: 'esm', write: false });
const { recommendVideoQuality, QUALITY_HOLD_MS } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

const calm = { panelWidth: 1000, drawnFramesPerSecond: 30, droppedFrames: 0, backlogBytes: 10_000, queueDepth: 1, sinceChangeMs: QUALITY_HOLD_MS + 1 };
const pressured = { ...calm, backlogBytes: 4_000_000, queueDepth: 9, droppedFrames: 4 };

test('a narrow panel stays on the cheap tier', () => {
  assert.equal(recommendVideoQuality('smooth', { ...calm, panelWidth: 360 }).quality, 'efficient');
});

test('over-budget readings step down one tier at a time', () => {
  assert.equal(recommendVideoQuality('smooth', pressured).quality, 'balanced');
  assert.equal(recommendVideoQuality('balanced', pressured).quality, 'efficient');
  const lowest = recommendVideoQuality('efficient', pressured);
  assert.equal(lowest.quality, 'efficient');
  assert.equal(lowest.changed, false);
  assert.equal(lowest.reason, 'pressure-at-lowest');
});

test('headroom only lifts one tier after the hold time', () => {
  assert.equal(recommendVideoQuality('efficient', calm).quality, 'balanced');
  const held = recommendVideoQuality('efficient', { ...calm, sinceChangeMs: 1_000 });
  assert.equal(held.quality, 'efficient');
  assert.equal(held.reason, 'hold');
});

test('a settled stream at the top tier does not report a change', () => {
  const steady = recommendVideoQuality('smooth', calm);
  assert.equal(steady.quality, 'smooth');
  assert.equal(steady.changed, false);
});

test('a low frame rate keeps the current tier instead of upshifting', () => {
  assert.equal(recommendVideoQuality('efficient', { ...calm, drawnFramesPerSecond: 8 }).quality, 'efficient');
});

test('downshifting is immediate but upshifting needs the hold window', () => {
  // Protecting the experience wins: a real over-budget reading steps down now.
  assert.equal(recommendVideoQuality('smooth', pressured).quality, 'balanced');
  assert.equal(recommendVideoQuality('balanced', { ...pressured, sinceChangeMs: 0 }).quality, 'efficient');
  // Lifting the tier is what flaps, so it needs margin plus the hold time.
  assert.equal(recommendVideoQuality('efficient', calm).quality, 'balanced');
  assert.equal(recommendVideoQuality('balanced', { ...calm, sinceChangeMs: 0 }).quality, 'balanced');
});
