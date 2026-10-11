import { createHash } from "node:crypto";
import { HarmonyError } from "../errors";
import { findHarmonyNodes, validateHarmonySelector } from "../selector";
import type { HarmonySnapshot, HarmonyUiSelector } from "../types";
export interface ObservationPageOptions { cursor?: string; limit?: number; selector?: HarmonyUiSelector; region?: { left: number; top: number; right: number; bottom: number }; ancestors?: boolean }
export function observationPage(snapshot: HarmonySnapshot, options: ObservationPageOptions) {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HarmonyError("INVALID_ARGUMENT", "Observation pages require 1–100 nodes");
  if (options.selector) validateHarmonySelector(options.selector);
  const region = options.region;
  if (region && (![region.left, region.top, region.right, region.bottom].every(Number.isFinite) || region.left < 0 || region.top < 0 || region.right <= region.left || region.bottom <= region.top)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid observation region");
  const filterHash = createHash("sha256").update(JSON.stringify([options.selector ?? null, region ?? null, options.ancestors ?? false])).digest("hex").slice(0, 16);
  const parts = options.cursor?.match(/^(\d+):(\d+):(\d+):([a-f0-9]{16})$/);
  if (options.cursor && (!parts || Number(parts[1]) !== snapshot.generation || Number(parts[2]) !== snapshot.revision || parts[4] !== filterHash)) throw new HarmonyError("STALE_SNAPSHOT", "Observation cursor or filters changed; request a new first page");
  const all = snapshot.nodes ?? [], offset = parts ? Number(parts[3]) : 0;
  const matching = (options.selector ? findHarmonyNodes(all, options.selector) : all).filter(node => !region || (node.bounds && node.bounds.right > region.left && node.bounds.left < region.right && node.bounds.bottom > region.top && node.bounds.top < region.bottom));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > matching.length) throw new HarmonyError("INVALID_ARGUMENT", "Invalid observation page offset");
  const nodes = matching.slice(offset, offset + limit), parents = new Map<string, (typeof all)[number]>(), byRef = new Map(all.map(node => [node.ref, node]));
  if (options.ancestors) for (const node of nodes) {
    let parent = node.parentRef;
    for (let depth = 0; parent && depth < 3 && parents.size < 50; depth++) {
      const ancestor = byRef.get(parent); if (!ancestor) break;
      parents.set(parent, ancestor); parent = ancestor.parentRef;
    }
  }
  const compact = (node: (typeof all)[number]) => ({ ...node, ...Object.fromEntries(["text", "hint", "description"].flatMap(key => typeof node[key as keyof typeof node] === "string" ? [[key, String(node[key as keyof typeof node]).slice(0, 500)]] : [])) });
  return { serial: snapshot.serial, generation: snapshot.generation, capturedAt: snapshot.capturedAt, quality: snapshot.quality,
    nodes: nodes.map(compact), ...(options.ancestors ? { ancestors: [...parents.values()].map(compact) } : {}), totalMatches: matching.length,
    nextCursor: offset + limit < matching.length ? `${snapshot.generation}:${snapshot.revision}:${offset + limit}:${filterHash}` : null };
}
