import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({ entryPoints: ['vendor/lib/harmony/observation/frame-gesture.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { beginFrameGesture, moveFrameGesture, finishFrameGesture } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`);
const frame = { serial: 'phone-a', generation: 3, geometryId: 'portrait', width: 1000, height: 2000 };
const rect = { left: 100, top: 50, width: 400, height: 600 };

test('a click maps CSS pixels through scaling and letterboxing to the displayed frame', () => {
  assert.equal(beginFrameGesture(frame, rect, 110, 200, 1, 0), null);
  const gesture = beginFrameGesture(frame, rect, 300, 350, 1, 0);
  const action = finishFrameGesture(gesture, { ...frame, revision: 100 }, rect, 302, 351, 100);
  assert.deepEqual(action, { action: 'tap', coordinateSpace: 'frame', geometryId: 'portrait', generation: 3, x: 500, y: 1000 });
});

test('moving then returning to the start is a gesture rather than an accidental click', () => {
  const gesture = beginFrameGesture(frame, rect, 300, 500, 1, 0);
  moveFrameGesture(gesture, 300, 200);
  const action = finishFrameGesture(gesture, frame, rect, 300, 500, 200);
  assert.equal(action.action, 'swipe');
  assert.equal(action.fromY, action.toY);
});

test('a held drag keeps frame coordinates and clamps a long mouse hold to the supported duration', () => {
  const gesture = beginFrameGesture(frame, rect, 300, 500, 1, 0);
  const action = finishFrameGesture(gesture, frame, rect, 300, 200, 15000);
  assert.equal(action.action, 'drag');
  assert.equal(action.fromY, 1500);
  assert.equal(action.toY, 500);
  assert.equal(action.durationMs, 10000);
});

test('release outside the image, device changes and rotation discard the gesture', () => {
  const gesture = beginFrameGesture(frame, rect, 300, 350, 1, 0);
  for (const changed of [null, { ...frame, serial: 'phone-b' }, { ...frame, generation: 4 }, { ...frame, geometryId: 'landscape' }, { ...frame, width: 2000, height: 1000 }]) {
    assert.equal(finishFrameGesture(gesture, changed, rect, 300, 350, 100), null);
  }
  assert.equal(finishFrameGesture(gesture, frame, rect, 120, 350, 100), null);
  assert.equal(beginFrameGesture({ ...frame, geometryId: undefined }, rect, 300, 350, 1, 0), null);
});
