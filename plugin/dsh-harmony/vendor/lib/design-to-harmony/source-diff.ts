import { flattenDesignIr } from "./normalize";
import { stableDesignHash } from "./stable-json";
import type {
  DesignDocumentSummary,
  DesignIrNode,
  DesignSyncImpact,
  HarmonyUiPlan,
  NormalizedDesignIR,
} from "./types";

function documentFingerprints(document: DesignDocumentSummary): Map<string, string> {
  const output = new Map<string, string>();
  const visit = (nodes: DesignDocumentSummary["pages"], ancestorIds: string[] = []) => {
    for (const node of nodes) {
      output.set(node.id, stableDesignHash({
        name: node.name,
        type: node.type,
        visible: node.visible,
        childCount: node.childCount,
        children: node.children.map((child) => child.id),
        ancestorIds,
      }));
      visit(node.children, [...ancestorIds, node.id]);
    }
  };
  visit(document.pages);
  for (const component of document.components) output.set(`component:${component.nodeId}`, stableDesignHash(component));
  for (const componentSet of document.componentSets) output.set(`component-set:${componentSet.nodeId}`, stableDesignHash(componentSet));
  for (const style of document.styles) output.set(`style:${style.nodeId}`, stableDesignHash(style));
  for (const variable of document.variables.variables) output.set(`variable:${variable.id}`, stableDesignHash(variable));
  for (const flow of document.flows) output.set(`flow:${flow.id}`, stableDesignHash(flow));
  return output;
}

function documentAncestors(document: DesignDocumentSummary): Map<string, string[]> {
  const output = new Map<string, string[]>();
  const visit = (nodes: DesignDocumentSummary["pages"], path: string[] = []) => {
    for (const node of nodes) {
      output.set(node.id, path);
      visit(node.children, [...path, node.id]);
    }
  };
  visit(document.pages);
  return output;
}

function relationTouchesTarget(id: string, target: string, ...ancestorMaps: Map<string, string[]>[]): boolean {
  if (id === target) return true;
  return ancestorMaps.some((map) => (map.get(id) ?? []).includes(target) || (map.get(target) ?? []).includes(id));
}

function result(input: {
  previousImportId?: string;
  changedNodeIds: string[];
  unchangedNodeIds: string[];
  removedNodeIds: string[];
  affectedSourceNodeIds: string[];
  plan?: HarmonyUiPlan;
  firstImport?: boolean;
}): DesignSyncImpact {
  const affected = new Set(input.affectedSourceNodeIds);
  return {
    ...(input.previousImportId ? { previousImportId: input.previousImportId } : {}),
    changedNodeIds: [...input.changedNodeIds].sort(),
    unchangedNodeIds: [...input.unchangedNodeIds].sort(),
    removedNodeIds: [...input.removedNodeIds].sort(),
    affectedSourceNodeIds: [...affected].sort(),
    affectedRelativePaths: input.plan?.files
      .filter((file) => affected.has(file.sourceNodeId))
      .map((file) => file.relativePath)
      .sort() ?? [],
    reason: input.firstImport ? "first_import" : input.changedNodeIds.length || input.removedNodeIds.length
      ? "source_version_changed"
      : "unchanged",
  };
}

/**
 * Summary-level fallback used when an older import does not have persisted normalized IR.
 * It deliberately treats design-system metadata as global so a stale generated file is
 * never omitted merely because the shallow import summary cannot prove its dependency.
 */
export function calculateDesignSyncImpact(input: {
  previous?: DesignDocumentSummary;
  current: DesignDocumentSummary;
  targetNodeIds: string[];
  plan?: HarmonyUiPlan;
  previousImportId?: string;
}): DesignSyncImpact {
  if (!input.previous) {
    return result({
      changedNodeIds: input.targetNodeIds,
      unchangedNodeIds: [],
      removedNodeIds: [],
      affectedSourceNodeIds: input.targetNodeIds,
      plan: input.plan,
      firstImport: true,
    });
  }
  const before = documentFingerprints(input.previous);
  const after = documentFingerprints(input.current);
  const changedNodeIds = [...after.entries()].filter(([id, hash]) => before.get(id) !== hash).map(([id]) => id);
  const unchangedNodeIds = [...after.entries()].filter(([id, hash]) => before.get(id) === hash).map(([id]) => id);
  const removedNodeIds = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...changedNodeIds, ...removedNodeIds];
  const beforeAncestors = documentAncestors(input.previous);
  const afterAncestors = documentAncestors(input.current);
  const globalDependencyChanged = changed.some((id) => /^(?:component(?:-set)?|style|variable|flow):/.test(id));
  const affected = globalDependencyChanged
    ? input.targetNodeIds
    : input.targetNodeIds.filter((target) => changed.some((id) => relationTouchesTarget(id, target, beforeAncestors, afterAncestors)));
  return result({
    previousImportId: input.previousImportId,
    changedNodeIds,
    unchangedNodeIds,
    removedNodeIds,
    affectedSourceNodeIds: affected,
    plan: input.plan,
  });
}

function irFingerprints(ir: NormalizedDesignIR): Map<string, string> {
  return new Map(flattenDesignIr(ir.roots).map((node) => {
    const { children, ...properties } = node;
    return [node.id, stableDesignHash({ ...properties, childIds: children.map((child) => child.id) })];
  }));
}

interface IrRelationships {
  ancestors: Map<string, string[]>;
  rootByNode: Map<string, string>;
  nodes: Map<string, DesignIrNode>;
}

function irRelationships(ir: NormalizedDesignIR): IrRelationships {
  const ancestors = new Map<string, string[]>();
  const rootByNode = new Map<string, string>();
  const nodes = new Map<string, DesignIrNode>();
  const visit = (node: DesignIrNode, rootId: string, path: string[]) => {
    nodes.set(node.id, node);
    ancestors.set(node.id, path);
    rootByNode.set(node.id, rootId);
    for (const child of node.children) visit(child, rootId, [...path, node.id]);
  };
  for (const root of ir.roots) visit(root, root.id, []);
  return { ancestors, rootByNode, nodes };
}

function targetDependencies(target: string, relationships: IrRelationships): {
  componentIds: Set<string>;
  interactionIds: Set<string>;
  variableIds: Set<string>;
} {
  const componentIds = new Set<string>();
  const interactionIds = new Set<string>();
  const variableIds = new Set<string>();
  for (const node of relationships.nodes.values()) {
    if (!relationTouchesTarget(node.id, target, relationships.ancestors)) continue;
    if (node.componentId) componentIds.add(node.componentId);
    for (const id of node.interactionTargetIds) interactionIds.add(id);
    for (const id of node.variableIds) variableIds.add(id);
  }
  return { componentIds, interactionIds, variableIds };
}

/** Full-tree impact analysis for imports that have both normalized IR snapshots. */
export function calculateDesignIrSyncImpact(input: {
  previous: NormalizedDesignIR;
  current: NormalizedDesignIR;
  previousDocument: DesignDocumentSummary;
  currentDocument: DesignDocumentSummary;
  targetNodeIds: string[];
  plan?: HarmonyUiPlan;
  previousImportId?: string;
}): DesignSyncImpact {
  const before = irFingerprints(input.previous);
  const after = irFingerprints(input.current);
  const beforeDocument = documentFingerprints(input.previousDocument);
  const afterDocument = documentFingerprints(input.currentDocument);
  const changedNodeIds = [
    ...[...after.entries()].filter(([id, hash]) => before.get(id) !== hash).map(([id]) => id),
    ...[...afterDocument.entries()].filter(([id, hash]) => beforeDocument.get(id) !== hash).map(([id]) => id),
  ];
  const unchangedNodeIds = [
    ...[...after.entries()].filter(([id, hash]) => before.get(id) === hash).map(([id]) => id),
    ...[...afterDocument.entries()].filter(([id, hash]) => beforeDocument.get(id) === hash).map(([id]) => id),
  ];
  const removedNodeIds = [
    ...[...before.keys()].filter((id) => !after.has(id)),
    ...[...beforeDocument.keys()].filter((id) => !afterDocument.has(id)),
  ];
  const changed = [...new Set([...changedNodeIds, ...removedNodeIds])];
  const previousRelationships = irRelationships(input.previous);
  const currentRelationships = irRelationships(input.current);
  const affected = input.targetNodeIds.filter((target) => {
    const directChange = changed.some((id) => !/^(?:component(?:-set)?|style|variable|flow):/.test(id)
      && relationTouchesTarget(id, target, previousRelationships.ancestors, currentRelationships.ancestors));
    if (directChange) return true;
    const previousDependencies = targetDependencies(target, previousRelationships);
    const currentDependencies = targetDependencies(target, currentRelationships);
    const componentIds = new Set([...previousDependencies.componentIds, ...currentDependencies.componentIds]);
    const interactionIds = new Set([...previousDependencies.interactionIds, ...currentDependencies.interactionIds]);
    const variableIds = new Set([...previousDependencies.variableIds, ...currentDependencies.variableIds]);
    return changed.some((id) => {
      if (id.startsWith("style:")) return true;
      if (id.startsWith("flow:")) return interactionIds.size > 0;
      if (id.startsWith("variable:")) return variableIds.has(id.slice("variable:".length));
      if (id.startsWith("component:")) return componentIds.has(id.slice("component:".length));
      if (id.startsWith("component-set:")) return componentIds.has(id.slice("component-set:".length));
      const dependencyRoot = currentRelationships.rootByNode.get(id) ?? previousRelationships.rootByNode.get(id) ?? id;
      return componentIds.has(dependencyRoot) || interactionIds.has(dependencyRoot);
    });
  });
  return result({
    previousImportId: input.previousImportId,
    changedNodeIds: [...new Set(changedNodeIds)],
    unchangedNodeIds: [...new Set(unchangedNodeIds)].filter((id) => !changed.includes(id)),
    removedNodeIds: [...new Set(removedNodeIds)],
    affectedSourceNodeIds: affected,
    plan: input.plan,
  });
}
