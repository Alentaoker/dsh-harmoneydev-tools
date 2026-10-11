import { HarmonyError } from "../errors";
import type { BackendSnapshot, HarmonyUiNode } from "../types";
import { requireValidObservation } from "./quality";

function label(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, " ").trim() || undefined;
}

/** Weak matches may inform a future observation, but cannot authorize a tap. */
export function resolveRetainedTarget(target: HarmonyUiNode, fresh: BackendSnapshot) {
  requireValidObservation(fresh);
  const labels = ["text", "hint", "description"] as const;
  const hasIdentity = Boolean(target.id || labels.some(key => label(target[key])));
  const matches = (fresh.nodes ?? []).filter(candidate => {
    if (!hasIdentity || !candidate.bounds || candidate.enabled === false || candidate.visible === false) return false;
    if (target.clickable === true && candidate.clickable !== true) return false;
    if (target.type && candidate.type !== target.type) return false;
    if (target.id && candidate.id !== target.id) return false;
    if (labels.some(key => label(target[key]) !== label(candidate[key]))) return false;
    return true;
  });
  // Count identity matches before considering location: a duplicate identifier
  // at another position must not silently select the nearest control.
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match?.bounds || !target.bounds) {
    throw new HarmonyError("STALE_SNAPSHOT", "The referenced target changed or is ambiguous; observe again", { retryable: true });
  }
  const width = Math.max(1, target.bounds.right - target.bounds.left);
  const height = Math.max(1, target.bounds.bottom - target.bounds.top);
  const distance = Math.hypot((target.bounds.left + target.bounds.right - match.bounds.left - match.bounds.right) / 2,
    (target.bounds.top + target.bounds.bottom - match.bounds.top - match.bounds.bottom) / 2);
  if (distance > Math.max(8, Math.min(width, height) * 0.15)) {
    throw new HarmonyError("STALE_SNAPSHOT", "The referenced target moved; observe again", { retryable: true });
  }
  return { ...match, bounds: match.bounds };
}
