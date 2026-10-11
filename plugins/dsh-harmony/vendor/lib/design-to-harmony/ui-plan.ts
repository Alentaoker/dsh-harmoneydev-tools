import { join, posix } from "node:path";
import { flattenDesignIr } from "./normalize";
import { stableDesignHash } from "./stable-json";
import type {
  DesignDependencyClosure,
  DesignImportRecord,
  DesignIrNode,
  DesignPlanIssue,
  HarmonyComponentMapping,
  HarmonyFilePlan,
  HarmonyInteractionMapping,
  HarmonyProjectInventory,
  HarmonyUiPlan,
  HarmonyVariableMapping,
  NormalizedDesignIR,
} from "./types";

function portablePath(...parts: string[]): string {
  return join(...parts).replace(/\\/g, "/");
}

function comparisonName(value: string): string {
  return value.normalize("NFKC").replace(/[\s_.-]+/g, "").toLocaleLowerCase("en-US");
}

function words(value: string): string[] {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function toArkSymbol(value: string, seed: string): string {
  const parts = words(value);
  const candidate = parts.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("");
  const prefixed = candidate && !/^\d/.test(candidate) ? candidate : candidate ? `Design${candidate}` : "Design";
  return `${prefixed}${stableDesignHash(seed).slice(0, 6).toUpperCase()}`;
}

function toResourceName(value: string, seed: string): string {
  const name = words(value).map((part) => part.toLowerCase()).join("_").replace(/^\d/, "design_$&");
  return `${name || "design_token"}_${stableDesignHash(seed).slice(0, 6)}`;
}

function nativeComponent(node: DesignIrNode): HarmonyFilePlan["rootComponent"] {
  if (node.kind === "text") return "Text";
  if (node.kind === "image") return "Image";
  if (node.kind === "shape" || node.kind === "vector") return "Shape";
  if (node.layout.mode === "row") return "Row";
  if (node.layout.mode === "column") return "Column";
  return "Stack";
}

function componentMappings(ir: NormalizedDesignIR, project: HarmonyProjectInventory): HarmonyComponentMapping[] {
  const known = new Map<string, HarmonyProjectInventory["modules"][number]["components"][number]>();
  for (const projectModule of project.modules) {
    for (const component of projectModule.components) known.set(comparisonName(component.name), component);
  }
  const targets = new Set(ir.targetNodeIds);
  return flattenDesignIr(ir.roots)
    .filter((node) => targets.has(node.id) || node.kind === "component" || node.kind === "component_set" || node.kind === "instance")
    .filter((node, index, nodes) => nodes.findIndex((candidate) => candidate.id === node.id) === index)
    .map((node) => {
      const reusable = known.get(comparisonName(node.name));
      if (reusable) {
        return {
          sourceNodeId: node.id,
          sourceName: node.name,
          strategy: "project_component" as const,
          targetName: reusable.name,
          targetPath: reusable.relativePath,
          confidence: "exact" as const,
        };
      }
      if (node.kind === "component" || node.kind === "component_set") {
        return {
          sourceNodeId: node.id,
          sourceName: node.name,
          strategy: "generate_component" as const,
          targetName: toArkSymbol(node.name, node.id),
          confidence: "inferred" as const,
        };
      }
      return {
        sourceNodeId: node.id,
        sourceName: node.name,
        strategy: "arkui_native" as const,
        targetName: nativeComponent(node),
        confidence: node.kind === "unknown" ? "fallback" as const : "inferred" as const,
      };
    })
    .sort((left, right) => left.sourceNodeId.localeCompare(right.sourceNodeId));
}

function variableMappings(record: DesignImportRecord, dependencies: DesignDependencyClosure): HarmonyVariableMapping[] {
  const needed = new Set(dependencies.variableIds);
  const resourceType = (resolvedType: HarmonyVariableMapping["resolvedType"]): HarmonyVariableMapping["resourceType"] => {
    if (resolvedType === "COLOR") return "color";
    if (resolvedType === "FLOAT") return "float";
    if (resolvedType === "STRING") return "string";
    if (resolvedType === "BOOLEAN") return "boolean";
    return "unknown";
  };
  return record.document.variables.variables
    .filter((variable) => needed.has(variable.id))
    .map((variable) => {
      const type = resourceType(variable.resolvedType);
      const resourceName = toResourceName(variable.name, variable.id);
      return {
        variableId: variable.id,
        sourceName: variable.name,
        resolvedType: variable.resolvedType,
        resourceType: type,
        resourceName,
        arkuiReference: type === "unknown" ? resourceName : `$r('app.${type}.${resourceName}')`,
      };
    })
    .sort((left, right) => left.variableId.localeCompare(right.variableId));
}

function interactionMappings(ir: NormalizedDesignIR): HarmonyInteractionMapping[] {
  const available = new Set(flattenDesignIr(ir.roots).map((node) => node.id));
  const mappings: HarmonyInteractionMapping[] = [];
  const seen = new Set<string>();
  for (const node of flattenDesignIr(ir.roots)) {
    for (const targetNodeId of node.interactionTargetIds) {
      const key = `${node.id}\0${targetNodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mappings.push({
        sourceNodeId: node.id,
        targetNodeId,
        strategy: available.has(targetNodeId) ? "router_push" : "placeholder",
        handlerName: `on${toArkSymbol(node.name, key)}Navigate`,
      });
    }
  }
  return mappings.sort((left, right) => left.sourceNodeId.localeCompare(right.sourceNodeId) || left.targetNodeId.localeCompare(right.targetNodeId));
}

function filePlans(ir: NormalizedDesignIR, project: HarmonyProjectInventory): HarmonyFilePlan[] {
  const roots = new Map(ir.roots.map((root) => [root.id, root]));
  const selectedModule = project.modules.find((candidate) => candidate.name === project.selectedModule) ?? project.modules[0];
  const outputRoot = selectedModule?.sourceRoot
    ? posix.join(selectedModule.sourceRoot, "generated", "design")
    : selectedModule
      ? posix.join(selectedModule.relativePath, "src", "main", "ets", "generated", "design")
      : "entry/src/main/ets/generated/design";
  return ir.targetNodeIds.flatMap((nodeId) => {
    const node = roots.get(nodeId);
    if (!node) return [];
    const symbolName = toArkSymbol(node.name, node.id);
    return [{
      sourceNodeId: node.id,
      sourceName: node.name,
      relativePath: portablePath(outputRoot, `${symbolName}.ets`),
      symbolName,
      rootComponent: nativeComponent(node),
    }];
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function buildHarmonyUiPlan(input: {
  record: DesignImportRecord;
  ir: NormalizedDesignIR;
  dependencies: DesignDependencyClosure;
  project: HarmonyProjectInventory;
  issues: DesignPlanIssue[];
}): HarmonyUiPlan {
  const files = filePlans(input.ir, input.project);
  const components = componentMappings(input.ir, input.project);
  const variables = variableMappings(input.record, input.dependencies);
  const interactions = interactionMappings(input.ir);
  const base = {
    schemaVersion: 1 as const,
    sourceImportId: input.record.id,
    sourceVersion: input.record.document.version.id,
    projectRoot: input.project.projectRoot,
    targetNodeIds: [...input.ir.targetNodeIds],
    ...(input.project.selectedModule ? { targetModule: input.project.selectedModule } : {}),
    dependencies: input.dependencies,
    files,
    componentMappings: components,
    variableMappings: variables,
    interactionMappings: interactions,
    issues: [...input.issues],
    stats: {
      irNodes: input.ir.nodeCount,
      outputFiles: files.length,
      blockingIssues: input.issues.filter((issue) => issue.severity === "blocking").length,
      confirmationIssues: input.issues.filter((issue) => issue.severity === "confirmation").length,
      reminders: input.issues.filter((issue) => issue.severity === "reminder").length,
    },
    irHash: input.ir.hash,
  };
  const hash = stableDesignHash(base);
  return { ...base, id: `plan_${hash.slice(0, 20)}`, hash };
}
