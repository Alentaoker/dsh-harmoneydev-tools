/**
 * One explicit phase for the device page's live view.
 *
 * The phase decides how often the browser may spend a screenshot, how often a
 * passive lock-state probe may run and whether a retry should skip the
 * exponential backoff. It is pure so the behaviour is regression-tested
 * without a device or a browser.
 */
export type HarmonyLiveViewPhase =
  | 'offline'
  | 'waiting-unlock'
  | 'busy'
  | 'connecting'
  | 'live'
  | 'compatible'
  | 'recovering'
  | 'paused';

export interface LiveViewPolicy {
  phase: HarmonyLiveViewPhase;
  /** Screenshot fallback pacing while the compatible preview is active. */
  screenshotIntervalMs: number;
  /** Passive `hidumper` lock-state probe pacing. */
  screenProbeIntervalMs: number;
  /** Bounded reconnect delay after a plain failure. */
  reconnectDelayMs: number;
  /** The real H.264 channel may be attempted in this phase. */
  videoAttemptAllowed: boolean;
}

export interface LiveViewPhaseInput {
  enabled: boolean;
  paused: boolean;
  online: boolean;
  awake?: boolean;
  locked?: boolean;
  mode: 'idle' | 'video' | 'frames';
  status: 'idle' | 'loading' | 'live' | 'error';
  videoBlocked: boolean;
}

/** 1～2 screenshots per second keeps the compatible preview useful and cheap. */
export const COMPATIBLE_SCREENSHOT_INTERVAL_MS = 750;
/** Locked phones only change on a person's input, so observation is minimal. */
export const LOCKED_SCREENSHOT_INTERVAL_MS = 2_000;
export const LOCKED_SCREEN_PROBE_INTERVAL_MS = 2_000;
export const IDLE_SCREEN_PROBE_INTERVAL_MS = 15_000;

export function resolveLiveViewPhase(input: LiveViewPhaseInput): HarmonyLiveViewPhase {
  if (!input.enabled) return 'offline';
  if (input.paused) return 'paused';
  if (!input.online) return 'offline';
  if (input.videoBlocked) return 'busy';
  // A locked or sleeping phone cannot serve H.264; waiting is its own phase so
  // it never inherits the plain-failure backoff that grows to two minutes.
  if (input.locked === true || input.awake === false) return 'waiting-unlock';
  if (input.mode === 'video') return input.status === 'live' ? 'live' : 'connecting';
  if (input.mode === 'frames') return input.status === 'live' ? 'compatible' : 'recovering';
  return 'connecting';
}

const POLICIES: Record<HarmonyLiveViewPhase, LiveViewPolicy> = {
  offline: { phase: 'offline', screenshotIntervalMs: 2_000, screenProbeIntervalMs: 4_000, reconnectDelayMs: 4_000, videoAttemptAllowed: false },
  'waiting-unlock': { phase: 'waiting-unlock', screenshotIntervalMs: LOCKED_SCREENSHOT_INTERVAL_MS, screenProbeIntervalMs: LOCKED_SCREEN_PROBE_INTERVAL_MS, reconnectDelayMs: 2_000, videoAttemptAllowed: false },
  busy: { phase: 'busy', screenshotIntervalMs: 1_500, screenProbeIntervalMs: LOCKED_SCREEN_PROBE_INTERVAL_MS, reconnectDelayMs: 10_000, videoAttemptAllowed: true },
  connecting: { phase: 'connecting', screenshotIntervalMs: COMPATIBLE_SCREENSHOT_INTERVAL_MS, screenProbeIntervalMs: 4_000, reconnectDelayMs: 1_000, videoAttemptAllowed: true },
  live: { phase: 'live', screenshotIntervalMs: 1_000, screenProbeIntervalMs: IDLE_SCREEN_PROBE_INTERVAL_MS, reconnectDelayMs: 250, videoAttemptAllowed: true },
  compatible: { phase: 'compatible', screenshotIntervalMs: COMPATIBLE_SCREENSHOT_INTERVAL_MS, screenProbeIntervalMs: LOCKED_SCREEN_PROBE_INTERVAL_MS, reconnectDelayMs: 1_000, videoAttemptAllowed: true },
  recovering: { phase: 'recovering', screenshotIntervalMs: COMPATIBLE_SCREENSHOT_INTERVAL_MS, screenProbeIntervalMs: LOCKED_SCREEN_PROBE_INTERVAL_MS, reconnectDelayMs: 2_000, videoAttemptAllowed: true },
  paused: { phase: 'paused', screenshotIntervalMs: 4_000, screenProbeIntervalMs: 10_000, reconnectDelayMs: 4_000, videoAttemptAllowed: false },
};

export function liveViewPolicy(phase: HarmonyLiveViewPhase): LiveViewPolicy {
  return POLICIES[phase];
}

/** Lock-state probing matters while waiting, on failure, and as a slow heartbeat. */
export function shouldProbeScreenState(phase: HarmonyLiveViewPhase): boolean {
  return phase !== 'offline' && phase !== 'paused';
}

/**
 * True when the previous sample proved the phone unusable for video and the new
 * one proves it usable. Callers then reconnect immediately instead of waiting
 * out the remaining backoff.
 */
export function unlockedSince(previous: HarmonyLiveViewPhase, next: HarmonyLiveViewPhase): boolean {
  return previous === 'waiting-unlock' && next !== 'waiting-unlock' && next !== 'offline' && next !== 'paused';
}
