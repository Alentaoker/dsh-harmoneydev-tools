import { collectDesignDependencies } from "./dependency-graph";
import { DesignToHarmonyError } from "./errors";
import { normalizeDesignNodes } from "./normalize";
import type { DesignSourceAdapter } from "./source-adapter";
import { buildHarmonyUiPlan } from "./ui-plan";
import { validateNormalizedDesign } from "./validate-ir";
import type {
  DesignImportRecord,
  DesignSourceNodePayload,
  HarmonyProjectInventory,
  HarmonyUiPlan,
  NormalizedDesignIR,
} from "./types";

const MAX_TARGETS = 24;
const MAX_FETCHED_NODES = 100;
const NODE_ID_PATTERN = /^(?:[A-Za-z0-9_-]{1,128}:)?[A-Za-z0-9_-]{1,128}$/;

function allowedSelectionIds(record: DesignImportRecord): Set<string> {
  const ids = new Set<string>();
  const visit = (nodes: DesignImportRecord["document"]["pages"]) => {
    for (const node of nodes) {
      ids.add(node.id);
      visit(node.children);
    }
  };
  visit(record.document.pages);
  for (const component of [...record.document.components, ...record.document.componentSets]) ids.add(component.nodeId);
  for (const flow of record.document.flows) ids.add(flow.nodeId);
  return ids;
}

export function validateDesignTargets(record: DesignImportRecord, values: unknown): string[] {
  if (!Array.isArray(values)) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "targetNodeIds must be an array", { status: 400, stage: "analyze" });
  }
  const targetNodeIds = [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()))].sort();
  if (targetNodeIds.length === 0 || targetNodeIds.length > MAX_TARGETS || targetNodeIds.some((id) => !NODE_ID_PATTERN.test(id))) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", `Select between 1 and ${MAX_TARGETS} valid design nodes`, { status: 400, stage: "analyze" });
  }
  const allowed = allowedSelectionIds(record);
  const unknown = targetNodeIds.filter((id) => !allowed.has(id));
  if (unknown.length) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "The selected nodes are not present in this imported design version", {
      status: 400,
      stage: "analyze",
      details: { nodeIds: unknown },
    });
  }
  return targetNodeIds;
}

function requirePayloads(requested: string[], payloads: DesignSourceNodePayload[]): void {
  const received = new Set(payloads.map((payload) => payload.id));
  const missing = requested.filter((id) => !received.has(id));
  if (missing.length) {
    throw new DesignToHarmonyError("ANALYSIS_FAILED", "The design source did not return every selected node", {
      status: 422,
      retryable: true,
      stage: "source",
      details: { nodeIds: missing },
    });
  }
}

export async function analyzeDesignSelection(input: {
  record: DesignImportRecord;
  targetNodeIds: string[];
  adapter: DesignSourceAdapter;
  project: HarmonyProjectInventory;
  includeInteractionTargets?: boolean;
  signal?: AbortSignal;
}): Promise<{ ir: NormalizedDesignIR; plan: HarmonyUiPlan }> {
  const targetNodeIds = validateDesignTargets(input.record, input.targetNodeIds);
  const sourceVersion = input.record.document.version.id;
  const selectedPayloads = await input.adapter.getNodes(input.record.source, targetNodeIds, input.signal, sourceVersion);
  requirePayloads(targetNodeIds, selectedPayloads);
  const payloads = new Map(selectedPayloads.map((payload) => [payload.id, payload]));
  let ir: NormalizedDesignIR;
  while (true) {
    ir = normalizeDesignNodes({
      sourceImportId: input.record.id,
      sourceVersion,
      targetNodeIds,
      payloads: [...payloads.values()],
    });
    const discovered = collectDesignDependencies(ir);
    const dependencyIds = [...new Set([
      ...discovered.componentNodeIds,
      ...discovered.interactionNodeIds,
    ])].filter((id) => !payloads.has(id)).sort();
    if (dependencyIds.length === 0) break;
    if (payloads.size + dependencyIds.length > MAX_FETCHED_NODES) {
      throw new DesignToHarmonyError("ANALYSIS_TOO_LARGE", `The selection expands to more than ${MAX_FETCHED_NODES} source nodes`, {
        status: 413,
        stage: "analyze",
        details: { targetCount: targetNodeIds.length, dependencyCount: payloads.size - targetNodeIds.length + dependencyIds.length },
      });
    }
    const fetched = await input.adapter.getNodes(input.record.source, dependencyIds, input.signal, sourceVersion);
    requirePayloads(dependencyIds, fetched);
    for (const payload of fetched) payloads.set(payload.id, payload);
  }
  if (input.includeInteractionTargets) {
    const reachableNodeIds = collectDesignDependencies(ir).interactionNodeIds.filter((id) => payloads.has(id));
    const expandedTargetNodeIds = [...new Set([...targetNodeIds, ...reachableNodeIds])].sort();
    if (expandedTargetNodeIds.length > MAX_TARGETS) {
      throw new DesignToHarmonyError("ANALYSIS_TOO_LARGE", `The selected flow reaches more than ${MAX_TARGETS} generated pages`, {
        status: 413,
        stage: "analyze",
        details: { selectedTargets: targetNodeIds.length, reachableTargets: expandedTargetNodeIds.length - targetNodeIds.length },
      });
    }
    if (expandedTargetNodeIds.length !== targetNodeIds.length) {
      ir = normalizeDesignNodes({
        sourceImportId: input.record.id,
        sourceVersion,
        targetNodeIds: expandedTargetNodeIds,
        payloads: [...payloads.values()],
      });
    }
  }
  const dependencies = collectDesignDependencies(ir);
  const issues = validateNormalizedDesign(ir, input.record, input.project);
  const plan = buildHarmonyUiPlan({ record: input.record, ir, dependencies, project: input.project, issues });
  return { ir, plan };
}
