/**
 * Quality tiers stay user-selectable; this module only produces an advisory
 * from measured pressure so the panel can suggest the same three tiers without
 * silently reconnecting the encoder.
 *
 * Downshifting needs a real over-budget reading; upshifting needs a wide margin
 * plus a minimum hold time, which is what keeps it from flapping.
 */
export type HarmonyVideoQuality = "efficient" | "balanced" | "smooth";

export interface QualitySignals {
  /** CSS width of the panel that actually displays the video. */
  panelWidth: number;
  /** Drawn frames per second measured over the last window. */
  drawnFramesPerSecond: number;
  /** Dependent frames skipped inside the same window. */
  droppedFrames: number;
  backlogBytes: number;
  queueDepth: number;
  /** Milliseconds since the tier last changed. */
  sinceChangeMs: number;
}

export interface QualityRecommendation {
  quality: HarmonyVideoQuality;
  reason: string;
  /** True when the application tier differs from the recommendation. */
  changed: boolean;
}

export const QUALITY_HOLD_MS = 15_000;
const BACKLOG_BUDGET = 1_500_000;
const NARROW_PANEL_PX = 480;
const WIDE_PANEL_PX = 900;
const SMOOTH_FPS = 24;

const ORDER: HarmonyVideoQuality[] = ["efficient", "balanced", "smooth"];

function underPressure(signals: QualitySignals) {
  return signals.backlogBytes > BACKLOG_BUDGET
    || signals.queueDepth > 6
    || signals.droppedFrames > 0;
}

function hasHeadroom(signals: QualitySignals) {
  return signals.backlogBytes < BACKLOG_BUDGET * 0.25
    && signals.queueDepth <= 2
    && signals.droppedFrames === 0;
}

export function recommendVideoQuality(current: HarmonyVideoQuality, signals: QualitySignals): QualityRecommendation {
  const index = Math.max(0, ORDER.indexOf(current));
  const change = (next: HarmonyVideoQuality, reason: string): QualityRecommendation =>
    next === current ? { quality: current, reason, changed: false } : { quality: next, reason, changed: true };

  if (signals.panelWidth > 0 && signals.panelWidth < NARROW_PANEL_PX) {
    // A small panel cannot show the extra detail, so do not pay for it.
    return change("efficient", "panel-narrow");
  }
  if (underPressure(signals)) {
    if (index === 0) return { quality: current, reason: "pressure-at-lowest", changed: false };
    // Never skip a tier: each step is one bounded change with its own hold time.
    return change(ORDER[index - 1], "over-budget");
  }
  if (signals.sinceChangeMs < QUALITY_HOLD_MS) return { quality: current, reason: "hold", changed: false };
  if (index < ORDER.length - 1 && hasHeadroom(signals)
    && signals.drawnFramesPerSecond >= SMOOTH_FPS && signals.panelWidth >= WIDE_PANEL_PX) {
    return change(ORDER[index + 1], "headroom");
  }
  return { quality: current, reason: "steady", changed: false };
}
