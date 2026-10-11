import { flattenDesignIr } from "./normalize";
import type { DesignDependencyClosure, NormalizedDesignIR } from "./types";

export function collectDesignDependencies(ir: NormalizedDesignIR): DesignDependencyClosure {
  const componentNodeIds = new Set<string>();
  const variableIds = new Set<string>();
  const assetRefs = new Set<string>();
  const interactionNodeIds = new Set<string>();
  const targets = new Set(ir.targetNodeIds);
  for (const node of flattenDesignIr(ir.roots)) {
    if (node.componentId && !targets.has(node.componentId)) componentNodeIds.add(node.componentId);
    for (const id of node.variableIds) variableIds.add(id);
    for (const ref of node.imageRefs) assetRefs.add(ref);
    for (const id of node.interactionTargetIds) if (!targets.has(id)) interactionNodeIds.add(id);
  }
  return {
    componentNodeIds: [...componentNodeIds].sort(),
    variableIds: [...variableIds].sort(),
    assetRefs: [...assetRefs].sort(),
    interactionNodeIds: [...interactionNodeIds].sort(),
  };
}
