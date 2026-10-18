import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['vendor/lib/harmony/media/video-backlog.ts'], bundle: true, format: 'esm', write: false });
const {
  VideoBacklog, admitVideoUnit, exceedsBacklogBudget, backlogAge, keyframeWaitExpired,
  BACKLOG_AGE_BUDGET_MS, BACKLOG_BYTE_BUDGET, KEYFRAME_WAIT_LIMIT_MS,
} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

test('a small recent backlog admits dependent frames', () => {
  const backlog = new VideoBacklog();
  backlog.push(20_000, 1_000);
  assert.equal(exceedsBacklogBudget(backlog.sample(1_050, 2)), false);
  assert.equal(admitVideoUnit({ keyframe: false, awaitingKeyframe: false, backlog: backlog.sample(1_050, 2) }).submit, true);
});

test('byte and age budgets both stop the preview without touching the recording', () => {
  const big = new VideoBacklog();
  big.push(BACKLOG_BYTE_BUDGET + 1, 0);
  assert.equal(exceedsBacklogBudget(big.sample(0, 1)), true);

  const old = new VideoBacklog();
  old.push(1_000, 0);
  assert.equal(backlogAge(old.sample(BACKLOG_AGE_BUDGET_MS + 1, 1)), BACKLOG_AGE_BUDGET_MS + 1);
  assert.equal(exceedsBacklogBudget(old.sample(BACKLOG_AGE_BUDGET_MS + 1, 1)), true);
});

test('releasing queued bytes restores the budget', () => {
  const backlog = new VideoBacklog();
  backlog.push(1_000_000, 0);
  backlog.push(1_000_000, 10);
  assert.equal(backlog.queuedBytes, 2_000_000);
  backlog.release(1_000_000);
  assert.equal(backlog.queuedBytes, 1_000_000);
  assert.equal(exceedsBacklogBudget(backlog.sample(20, 0)), false);
});

test('an over-budget dependent frame waits for the next keyframe instead of being dropped alone', () => {
  const backlog = new VideoBacklog();
  backlog.push(BACKLOG_BYTE_BUDGET + 1, 0);
  const dropped = admitVideoUnit({ keyframe: false, awaitingKeyframe: false, backlog: backlog.sample(0, 0) });
  assert.equal(dropped.submit, false);
  assert.equal(dropped.awaitingKeyframe, true);

  const stillWaiting = admitVideoUnit({ keyframe: false, awaitingKeyframe: true, backlog: backlog.sample(0, 0) });
  assert.equal(stillWaiting.submit, false);

  const resumed = admitVideoUnit({ keyframe: true, awaitingKeyframe: true, backlog: backlog.sample(0, 0) });
  assert.equal(resumed.submit, true, 'a keyframe restarts the reference chain');
  assert.equal(resumed.awaitingKeyframe, false);
});

test('the keyframe wait is bounded so a static screen cannot freeze the preview', () => {
  // A change-driven source emits nothing while the screen is static, so the
  // caller must be able to force a fresh IDR instead of waiting forever.
  assert.equal(keyframeWaitExpired(null, 1_000_000), false, 'no wait in progress');
  assert.equal(keyframeWaitExpired(1_000, 1_000 + KEYFRAME_WAIT_LIMIT_MS - 1), false);
  assert.equal(keyframeWaitExpired(1_000, 1_000 + KEYFRAME_WAIT_LIMIT_MS), true);
  assert.ok(KEYFRAME_WAIT_LIMIT_MS > 0 && KEYFRAME_WAIT_LIMIT_MS <= 5_000, 'the bound is a short, user-visible delay');
});

test('live frames are drawn before the budget is reached', () => {
  const backlog = new VideoBacklog();
  for (let index = 0; index < 5; index += 1) {
    const admission = admitVideoUnit({ keyframe: false, awaitingKeyframe: false, backlog: backlog.sample(index * 10, 1) });
    assert.equal(admission.submit, true);
    backlog.push(40_000, index * 10);
    backlog.release(40_000);
  }
  assert.equal(backlog.queuedBytes, 0);
  assert.equal(backlog.queuedSince, null);
});
