import { stableDesignHash } from "./stable-json";
import { flattenDesignIr } from "./normalize";
import type { DesignImportRecord, DesignPlanIssue, HarmonyProjectInventory, NormalizedDesignIR } from "./types";

function issue(input: Omit<DesignPlanIssue, "id">): DesignPlanIssue {
  return { id: `issue_${stableDesignHash(input).slice(0, 16)}`, ...input };
}

function groupedIssue(
  nodes: Array<{ id: string }>,
  input: Omit<DesignPlanIssue, "id" | "sourceNodeIds">,
): DesignPlanIssue | null {
  if (nodes.length === 0) return null;
  return issue({ ...input, sourceNodeIds: [...new Set(nodes.map((node) => node.id))].sort() });
}

export function validateNormalizedDesign(
  ir: NormalizedDesignIR,
  record: DesignImportRecord,
  project: HarmonyProjectInventory,
): DesignPlanIssue[] {
  const nodes = flattenDesignIr(ir.roots);
  const issues: Array<DesignPlanIssue | null> = [];
  if (project.modules.length === 0) {
    issues.push(issue({
      severity: "blocking",
      code: "HARMONY_MODULE_MISSING",
      title: "Harmony module not found",
      message: "The selected project does not contain a src/main/module.json5 module.",
      sourceNodeIds: ir.targetNodeIds,
      suggestedResolution: "Select a HarmonyOS project or add a valid module before generation.",
    }));
  }
  if (project.truncated) {
    issues.push(issue({
      severity: "reminder",
      code: "PROJECT_SCAN_TRUNCATED",
      title: "Project scan was bounded",
      message: "The project contains more entries than the analysis scan limit, so some reusable components may be omitted.",
      sourceNodeIds: [],
    }));
  }
  issues.push(groupedIssue(nodes.filter((node) => ["WIDGET", "EMBED", "LINK_UNFURL", "MEDIA", "UNKNOWN"].includes(node.sourceType)), {
    severity: "blocking",
    code: "UNSUPPORTED_NODE_TYPE",
    title: "Unsupported design nodes",
    message: "Some selected nodes cannot be represented safely in ArkUI and will not be silently dropped.",
    suggestedResolution: "Replace these nodes in the design or define an explicit placeholder mapping.",
  }));
  issues.push(groupedIssue(nodes.filter((node) => !["NORMAL", "PASS_THROUGH"].includes(node.blendMode)), {
    severity: "confirmation",
    code: "BLEND_MODE_FALLBACK",
    title: "Blend mode requires a fallback",
    message: "ArkUI output will use normal compositing unless a custom rendering strategy is selected.",
    suggestedResolution: "Approve normal compositing or map the node to a custom project component.",
  }));
  issues.push(groupedIssue(nodes.filter((node) => node.effects.some((effect) => effect.includes("BLUR"))), {
    severity: "confirmation",
    code: "BLUR_EFFECT_FALLBACK",
    title: "Blur effect may differ",
    message: "Blur effects vary by HarmonyOS API level and require an explicit degradation choice.",
    suggestedResolution: "Use the target API blur implementation or approve a shadow/color fallback.",
  }));
  issues.push(groupedIssue(nodes.filter((node) => node.layout.absolute), {
    severity: "reminder",
    code: "ABSOLUTE_LAYOUT",
    title: "Absolute layout detected",
    message: "Absolute child positioning will be mapped to Stack offsets and may need responsive adjustment.",
  }));
  if (record.document.variables.availability !== "available") {
    issues.push(issue({
      severity: "reminder",
      code: "VARIABLES_UNAVAILABLE",
      title: "Design variables are unavailable",
      message: record.document.variables.reason ?? "Variable metadata was not available during import.",
      sourceNodeIds: [],
    }));
  }
  const knownVariables = new Set(record.document.variables.variables.map((variable) => variable.id));
  issues.push(groupedIssue(nodes.filter((node) => node.variableIds.some((id) => !knownVariables.has(id))), {
    severity: "confirmation",
    code: "VARIABLE_REFERENCE_MISSING",
    title: "Variable references are incomplete",
    message: "Some bound variables are not present in the imported variable catalog.",
    suggestedResolution: "Reconnect with variable read access or approve literal fallback values.",
  }));
  return issues.filter((item): item is DesignPlanIssue => item !== null)
    .sort((left, right) => {
      const order = { blocking: 0, confirmation: 1, reminder: 2 } as const;
      return order[left.severity] - order[right.severity] || left.code.localeCompare(right.code) || left.id.localeCompare(right.id);
    });
}
