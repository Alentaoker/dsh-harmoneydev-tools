/**
 * Bounded preview backlog accounting.
 *
 * H.264 frames are inter-dependent, so an arbitrary frame may not be dropped.
 * Instead the reader tracks how much compressed data is still queued and for
 * how long; when the budget is exceeded it stops submitting dependent frames
 * and waits for the next keyframe (IDR), which is the only safe resynchronising
 * point. The device keeps encoding and the server keeps recording, so trimming
 * the live preview never truncates a recording.
 */
export interface VideoBacklogSample {
  queuedBytes: number;
  /** Wall-clock time of the oldest still-queued byte, or null when empty. */
  queuedSince: number | null;
  queueDepth: number;
  now: number;
}

/** 150～250 ms of preview backlog is the tested budget. */
export const BACKLOG_AGE_BUDGET_MS = 200;
/** Roughly one 1272x2800 IDR plus a burst of deltas. */
export const BACKLOG_BYTE_BUDGET = 1_500_000;
export const QUEUE_DEPTH_SOFT_LIMIT = 8;
/**
 * Once dependent frames have been skipped, the reference chain is broken and
 * only a keyframe may resume submission. This change-driven source emits nothing
 * while the screen is static, so waiting for one can stall forever: after this
 * bound the caller must ask for a fresh IDR (reconnect) instead of staying
 * frozen on a stale picture.
 */
export const KEYFRAME_WAIT_LIMIT_MS = 2_000;

export function backlogAge(sample: Pick<VideoBacklogSample, 'queuedSince' | 'now'>): number {
  return sample.queuedSince === null ? 0 : Math.max(0, sample.now - sample.queuedSince);
}

export function exceedsBacklogBudget(sample: VideoBacklogSample): boolean {
  if (sample.queuedBytes <= 0) return false;
  return sample.queuedBytes > BACKLOG_BYTE_BUDGET
    || backlogAge(sample) > BACKLOG_AGE_BUDGET_MS
    || sample.queueDepth > QUEUE_DEPTH_SOFT_LIMIT * 2;
}

/**
 * Decide whether an H.264 access unit may be submitted right now.
 * `awaitingKeyframe` is sticky until a keyframe actually arrives.
 */
export function admitVideoUnit(options: {
  keyframe: boolean;
  awaitingKeyframe: boolean;
  backlog: VideoBacklogSample;
}): { submit: boolean; awaitingKeyframe: boolean; droppedDependent: boolean } {
  if (options.keyframe) return { submit: true, awaitingKeyframe: false, droppedDependent: false };
  if (options.awaitingKeyframe) return { submit: false, awaitingKeyframe: true, droppedDependent: true };
  if (exceedsBacklogBudget(options.backlog)) return { submit: false, awaitingKeyframe: true, droppedDependent: true };
  return { submit: true, awaitingKeyframe: false, droppedDependent: false };
}

/**
 * A bounded escape from "waiting for the next keyframe". Returns true when the
 * wait has lasted long enough that the caller should force a fresh IDR.
 */
export function keyframeWaitExpired(awaitingSince: number | null, now: number, limitMs = KEYFRAME_WAIT_LIMIT_MS): boolean {
  if (awaitingSince === null) return false;
  return now - awaitingSince >= limitMs;
}

/** Tracks compressed bytes still queued between the reader and the decoder. */
export class VideoBacklog {
  private entries: Array<{ bytes: number; at: number }> = [];
  private total = 0;

  push(bytes: number, now: number) {
    if (bytes <= 0) return;
    this.entries.push({ bytes, at: now });
    this.total += bytes;
  }

  release(bytes: number) {
    let remaining = Math.max(0, bytes);
    while (remaining > 0 && this.entries.length) {
      const head = this.entries[0];
      if (head.bytes <= remaining) { remaining -= head.bytes; this.total -= head.bytes; this.entries.shift(); }
      else { head.bytes -= remaining; this.total -= remaining; remaining = 0; }
    }
    if (this.total < 0) { this.total = 0; this.entries = []; }
  }

  clear() { this.entries = []; this.total = 0; }

  get queuedBytes() { return this.total; }
  get queuedSince(): number | null { return this.entries[0]?.at ?? null; }

  sample(now: number, queueDepth: number): VideoBacklogSample {
    return { queuedBytes: this.total, queuedSince: this.queuedSince, queueDepth, now };
  }
}
