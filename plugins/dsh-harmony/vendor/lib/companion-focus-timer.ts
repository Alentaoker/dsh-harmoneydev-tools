import type {
  CompanionFocusTimer,
  CompanionFocusTimerPhase,
} from "./companion-runtime";

export const COMPANION_FOCUS_DURATIONS: Record<CompanionFocusTimerPhase, number> = {
  focus: 25 * 60,
  "short-break": 5 * 60,
  "long-break": 15 * 60,
};

export interface CompanionFocusPetPresentation {
  phase: CompanionFocusTimerPhase;
  status: "running" | "paused";
  remainingSeconds: number;
}

export function getCompanionFocusPetPresentation(
  timer: CompanionFocusTimer,
  now = Date.now(),
): CompanionFocusPetPresentation | null {
  if (timer.status !== "running" && timer.status !== "paused") return null;
  return {
    phase: timer.phase,
    status: timer.status,
    remainingSeconds: getCompanionFocusRemainingSeconds(timer, now),
  };
}

export function formatCompanionFocusCountdown(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function getCompanionFocusRemainingSeconds(
  timer: CompanionFocusTimer,
  now = Date.now(),
): number {
  if (timer.status !== "running" || timer.endsAt === null) return timer.remainingSeconds;
  return Math.max(0, Math.ceil((timer.endsAt - now) / 1_000));
}

export function startCompanionFocusTimer(
  timer: CompanionFocusTimer,
  now = Date.now(),
): CompanionFocusTimer {
  const remainingSeconds = timer.remainingSeconds > 0
    ? timer.remainingSeconds
    : timer.durationSeconds;
  return {
    ...timer,
    status: "running",
    remainingSeconds,
    startedAt: now,
    endsAt: now + remainingSeconds * 1_000,
  };
}

export function pauseCompanionFocusTimer(
  timer: CompanionFocusTimer,
  now = Date.now(),
): CompanionFocusTimer {
  return {
    ...timer,
    status: "paused",
    remainingSeconds: getCompanionFocusRemainingSeconds(timer, now),
    startedAt: null,
    endsAt: null,
  };
}

export function selectCompanionFocusPhase(
  timer: CompanionFocusTimer,
  phase: CompanionFocusTimerPhase,
): CompanionFocusTimer {
  const durationSeconds = timer.durations[phase];
  return {
    ...timer,
    phase,
    status: "idle",
    durationSeconds,
    remainingSeconds: durationSeconds,
    startedAt: null,
    endsAt: null,
  };
}

export function resetCompanionFocusTimer(timer: CompanionFocusTimer): CompanionFocusTimer {
  const durationSeconds = timer.durations[timer.phase];
  return {
    ...timer,
    status: "idle",
    durationSeconds,
    remainingSeconds: durationSeconds,
    startedAt: null,
    endsAt: null,
  };
}

export function updateCompanionFocusDuration(
  timer: CompanionFocusTimer,
  phase: CompanionFocusTimerPhase,
  durationSeconds: number,
): CompanionFocusTimer {
  const safeDuration = Math.max(60, Math.min(4 * 60 * 60, Math.round(durationSeconds)));
  const durations = { ...timer.durations, [phase]: safeDuration };
  if (timer.phase !== phase || timer.status === "running") return { ...timer, durations };
  return {
    ...timer,
    durations,
    durationSeconds: safeDuration,
    remainingSeconds: safeDuration,
  };
}

export function completeCompanionFocusTimer(
  timer: CompanionFocusTimer,
  now = Date.now(),
): CompanionFocusTimer {
  const completedFocusSessions = timer.completedFocusSessions + (timer.phase === "focus" ? 1 : 0);
  const nextPhase: CompanionFocusTimerPhase = timer.phase === "focus"
    ? (completedFocusSessions % timer.longBreakEvery === 0 ? "long-break" : "short-break")
    : "focus";
  const durationSeconds = timer.durations[nextPhase];
  const nextTimer: CompanionFocusTimer = {
    ...timer,
    phase: nextPhase,
    status: "idle",
    durationSeconds,
    remainingSeconds: durationSeconds,
    startedAt: null,
    endsAt: null,
    completedFocusSessions,
  };
  return timer.autoStartNextPhase ? startCompanionFocusTimer(nextTimer, now) : nextTimer;
}
