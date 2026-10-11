import type { CompanionActivityStatus } from "./companion";
import type { TaskRuntimeActivityKind, TaskRuntimeSnapshot } from "./task-status";

/**
 * Pure presentation behavior for companion animations and agent-state
 * presentation. Speech is intentionally model-generated elsewhere.
 */

export type CompanionInteractionKind = "poke";

export interface CompanionTaskPresentation {
  status: CompanionActivityStatus;
  activityKind: TaskRuntimeActivityKind | "idle" | "failed" | "review";
}

/**
 * Normalizes the agent runtime into pet-facing state. The task stream remains
 * the source of truth; the pet never guesses work from timers or chat text.
 */
export function deriveCompanionTaskPresentation(
  snapshot: Pick<TaskRuntimeSnapshot, "runtime" | "pendingApproval" | "lastPromptFailed" | "activity" | "taskRun">,
): CompanionTaskPresentation {
  if (snapshot.lastPromptFailed || snapshot.taskRun?.phase === "failed") {
    return { status: "failed", activityKind: "failed" };
  }
  if (
    snapshot.pendingApproval
    || snapshot.activity?.kind === "approval"
    || snapshot.taskRun?.phase === "waiting_approval"
    || snapshot.taskRun?.phase === "waiting_user"
  ) {
    return { status: "review", activityKind: "review" };
  }
  if (snapshot.runtime === "idle") return { status: "idle", activityKind: "idle" };
  if (snapshot.activity?.kind === "thinking" || snapshot.activity?.kind === "retry") {
    return { status: "waiting", activityKind: snapshot.activity.kind };
  }
  if (snapshot.runtime === "compacting") return { status: "running", activityKind: "compacting" };
  return { status: "running", activityKind: snapshot.activity?.kind ?? "prompt" };
}

export const COMPANION_WANDER_MIN_DELAY_MS = 10_000;
export const COMPANION_WANDER_EXTRA_DELAY_MS = 14_000;

export function getCompanionWanderDelay(random: () => number = Math.random): number {
  return Math.round(COMPANION_WANDER_MIN_DELAY_MS + random() * COMPANION_WANDER_EXTRA_DELAY_MS);
}

export function isCompanionInteractionKind(value: unknown): value is CompanionInteractionKind {
  return value === "poke";
}

/** Reaction animation preferences per interaction, ordered best-first. */
const INTERACTION_STATE_PREFERENCES: Record<CompanionInteractionKind, readonly string[]> = {
  poke: ["jumping", "bounce", "look-directions-a", "waving", "idle"],
};

const IDLE_TRICK_STATE_PREFERENCES: readonly string[] = [
  "waving", "jumping", "look-directions-a", "look-directions-b", "bounce", "spin", "dance",
];

/**
 * Picks a one-shot animation for an interaction or idle trick. Prefers the
 * pet-specific chain, avoids repeating the previous choice while a different
 * candidate exists, and returns null when the sprite has no suitable state.
 */
export function pickCompanionReactionStateId(
  availableIds: readonly string[],
  preferenceChain: readonly string[],
  previousId?: string | null,
  random: () => number = Math.random,
): string | null {
  const available = new Set(availableIds);
  const candidates = preferenceChain.filter((id) => available.has(id));
  if (candidates.length === 0) return null;
  const varied = candidates.filter((id) => id !== previousId);
  const pool = varied.length > 0 ? varied : candidates;
  return pool[Math.floor(random() * pool.length)] ?? null;
}

export function pickCompanionIdleTrickStateId(
  availableIds: readonly string[],
  previousId?: string | null,
  random: () => number = Math.random,
): string | null {
  return pickCompanionReactionStateId(availableIds, IDLE_TRICK_STATE_PREFERENCES, previousId, random);
}

export function pickCompanionInteractionStateId(
  availableIds: readonly string[],
  kind: CompanionInteractionKind,
  previousId?: string | null,
  random: () => number = Math.random,
): string | null {
  return pickCompanionReactionStateId(availableIds, INTERACTION_STATE_PREFERENCES[kind], previousId, random);
}
