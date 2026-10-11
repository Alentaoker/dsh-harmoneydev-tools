import { HarmonyError } from "../errors";
import type { BackendSnapshot, HarmonySnapshot } from "../types";
import type { HarmonyObservationQuality } from "../contracts/observations";

type Observation = Pick<BackendSnapshot, "nodes" | "quality"> | Pick<HarmonySnapshot, "nodes" | "quality">;

export function observationQuality(value: Observation): HarmonyObservationQuality {
  if (value.quality) return { ...value.quality };
  // Compatibility for older backends: positive nodes may be used for a fresh
  // target lookup, but an unqualified empty list never proves absence.
  return value.nodes?.length
    ? { treeStatus: "valid", scopeComplete: value.nodes.length < 10_000, scope: "unknown" }
    : { treeStatus: "unavailable", scopeComplete: false, scope: "unknown" };
}

export function requireValidObservation(value: Observation, negative = false): void {
  const quality = observationQuality(value);
  if (!Array.isArray(value.nodes) || quality.treeStatus !== "valid" || !quality.scopeComplete
    || (negative && quality.scope !== "active-windows" && !quality.windowId)) {
    throw new HarmonyError("OBSERVATION_UNAVAILABLE", "A complete, valid UI observation is required; observe again before acting or asserting absence", {
      retryable: true,
      details: { treeStatus: quality.treeStatus, scopeComplete: quality.scopeComplete },
    });
  }
}
