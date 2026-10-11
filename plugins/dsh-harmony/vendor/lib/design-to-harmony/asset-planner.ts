import { posix } from "node:path";
import { flattenDesignIr } from "./normalize";
import { stableDesignHash } from "./stable-json";
import type { DesignAssetPlanItem, HarmonyUiPlan, NormalizedDesignIR } from "./types";

function resourceRoot(plan: HarmonyUiPlan): string {
  const sourcePath = plan.files[0]?.relativePath.replace(/\\/g, "/") ?? "entry/src/main/ets/generated/design/Preview.ets";
  const marker = "/src/main/ets/";
  const index = `/${sourcePath}`.indexOf(marker);
  const moduleRoot = index >= 0 ? `/${sourcePath}`.slice(1, index) : "entry";
  // Harmony resource qualifiers permit files directly under base/media, but
  // nested arbitrary folders are rejected by the resource compiler.
  return posix.join(moduleRoot, "src/main/resources/base/media");
}

function resourceName(nodeName: string, sourceRef: string): string {
  const words = nodeName.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const safe = words && !/^\d/.test(words) ? words : `asset_${words || "image"}`;
  return `design_${safe}_${stableDesignHash(sourceRef).slice(0, 8)}`;
}

export function planDesignAssets(
  ir: NormalizedDesignIR,
  plan: HarmonyUiPlan,
  exportedNodeIds: ReadonlySet<string> = new Set(),
  fallbackReasons: ReadonlyMap<string, string> = new Map(),
): DesignAssetPlanItem[] {
  const outputRoot = resourceRoot(plan);
  const items = flattenDesignIr(ir.roots).flatMap((node) => node.imageRefs.map((sourceRef) => {
    const name = resourceName(node.name, `${node.id}\0${sourceRef}`);
    return {
      sourceNodeId: node.id,
      sourceRef,
      resourceName: name,
      relativePath: posix.join(outputRoot, `${name}.${exportedNodeIds.has(node.id) ? "png" : "svg"}`),
      strategy: exportedNodeIds.has(node.id) ? "source_render_png" as const : "placeholder_svg" as const,
      ...(fallbackReasons.get(node.id) ? { fallbackReason: fallbackReasons.get(node.id) } : {}),
    };
  }));
  return items
    .filter((item, index) => items.findIndex((candidate) => candidate.relativePath === item.relativePath) === index)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
