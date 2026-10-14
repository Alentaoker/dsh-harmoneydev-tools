import { DesignToHarmonyError } from "./errors";
import { stableDesignHash } from "./stable-json";
import type {
  DesignIrLayout,
  DesignIrNode,
  DesignIrNodeKind,
  DesignIrPaint,
  DesignNodeType,
  DesignSourceNodePayload,
  NormalizedDesignIR,
} from "./types";

const MAX_IR_NODES = 5_000;
const MAX_REFERENCE_SCAN_DEPTH = 12;
const SUPPORTED_NODE_TYPES = new Set<DesignNodeType>([
  "DOCUMENT", "CANVAS", "SECTION", "FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE",
  "TEXT", "VECTOR", "RECTANGLE", "ELLIPSE", "LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION", "SLICE",
  "STAMP", "HIGHLIGHT", "WASHI_TAPE", "SHAPE_WITH_TEXT", "CODE_BLOCK", "CONNECTOR", "WIDGET", "EMBED",
  "LINK_UNFURL", "MEDIA", "UNKNOWN",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedNumber(value: unknown, fallback = 0, minimum = -1_000_000, maximum = 1_000_000): number {
  const number = optionalNumber(value);
  return number === undefined ? fallback : Math.max(minimum, Math.min(maximum, number));
}

function sourceType(value: unknown): DesignNodeType {
  const normalized = stringValue(value, "UNKNOWN").toUpperCase() as DesignNodeType;
  return SUPPORTED_NODE_TYPES.has(normalized) ? normalized : "UNKNOWN";
}

function nodeKind(type: DesignNodeType, value: Record<string, unknown>): DesignIrNodeKind {
  if (type === "CANVAS") return "page";
  if (type === "COMPONENT") return "component";
  if (type === "COMPONENT_SET") return "component_set";
  if (type === "INSTANCE") return "instance";
  if (type === "TEXT" || type === "CODE_BLOCK" || type === "SHAPE_WITH_TEXT") return "text";
  if (type === "VECTOR" || type === "BOOLEAN_OPERATION") return "vector";
  if (["RECTANGLE", "ELLIPSE", "LINE", "STAR", "POLYGON"].includes(type)) {
    const fills = Array.isArray(value.fills) ? value.fills : [];
    return fills.some((paint) => isRecord(paint) && paint.type === "IMAGE") ? "image" : "shape";
  }
  if (["DOCUMENT", "SECTION", "FRAME", "GROUP"].includes(type)) return "container";
  return "unknown";
}

function sizing(value: unknown): DesignIrLayout["primarySizing"] {
  const normalized = stringValue(value).toUpperCase();
  if (normalized === "FIXED") return "fixed";
  if (normalized === "HUG" || normalized === "HUG_CONTENT") return "hug";
  if (normalized === "FILL" || normalized === "FILL_CONTAINER") return "fill";
  return "unknown";
}

function primaryAlign(value: unknown): DesignIrLayout["primaryAlign"] {
  const normalized = stringValue(value).toUpperCase();
  if (normalized === "MIN" || normalized === "START") return "start";
  if (normalized === "CENTER") return "center";
  if (normalized === "MAX" || normalized === "END") return "end";
  if (normalized === "SPACE_BETWEEN") return "space_between";
  return "unknown";
}

function counterAlign(value: unknown): DesignIrLayout["counterAlign"] {
  const normalized = stringValue(value).toUpperCase();
  if (normalized === "MIN" || normalized === "START") return "start";
  if (normalized === "CENTER") return "center";
  if (normalized === "MAX" || normalized === "END") return "end";
  if (normalized === "BASELINE") return "baseline";
  return "unknown";
}

function normalizeLayout(value: Record<string, unknown>): DesignIrLayout {
  const box = isRecord(value.absoluteBoundingBox) ? value.absoluteBoundingBox : {};
  const rawMode = stringValue(value.layoutMode).toUpperCase();
  const mode: DesignIrLayout["mode"] = rawMode === "HORIZONTAL" ? "row" : rawMode === "VERTICAL" ? "column" : "none";
  return {
    mode,
    ...(optionalNumber(box.width) !== undefined ? { width: boundedNumber(box.width) } : {}),
    ...(optionalNumber(box.height) !== undefined ? { height: boundedNumber(box.height) } : {}),
    ...(optionalNumber(box.x) !== undefined ? { x: boundedNumber(box.x) } : {}),
    ...(optionalNumber(box.y) !== undefined ? { y: boundedNumber(box.y) } : {}),
    gap: boundedNumber(value.itemSpacing),
    padding: {
      top: boundedNumber(value.paddingTop),
      right: boundedNumber(value.paddingRight),
      bottom: boundedNumber(value.paddingBottom),
      left: boundedNumber(value.paddingLeft),
    },
    primarySizing: sizing(value.primaryAxisSizingMode),
    counterSizing: sizing(value.counterAxisSizingMode),
    primaryAlign: primaryAlign(value.primaryAxisAlignItems),
    counterAlign: counterAlign(value.counterAxisAlignItems),
    absolute: stringValue(value.layoutPositioning).toUpperCase() === "ABSOLUTE",
    clipsContent: value.clipsContent === true,
  };
}

function normalizeColor(value: unknown): DesignIrPaint["color"] | undefined {
  if (!isRecord(value)) return undefined;
  return {
    red: Math.max(0, Math.min(1, boundedNumber(value.r, 0, 0, 1))),
    green: Math.max(0, Math.min(1, boundedNumber(value.g, 0, 0, 1))),
    blue: Math.max(0, Math.min(1, boundedNumber(value.b, 0, 0, 1))),
    alpha: Math.max(0, Math.min(1, boundedNumber(value.a, 1, 0, 1))),
  };
}

function variableAlias(value: unknown): string | undefined {
  return isRecord(value) && value.type === "VARIABLE_ALIAS" && typeof value.id === "string" ? value.id : undefined;
}

function normalizePaint(value: unknown): DesignIrPaint | null {
  if (!isRecord(value)) return null;
  const rawType = stringValue(value.type).toUpperCase();
  const type: DesignIrPaint["type"] = rawType === "SOLID"
    ? "solid"
    : rawType.startsWith("GRADIENT_")
      ? "gradient"
      : rawType === "IMAGE"
        ? "image"
        : "unknown";
  const boundVariables = isRecord(value.boundVariables) ? value.boundVariables : {};
  const variableId = variableAlias(boundVariables.color) ?? variableAlias(boundVariables.opacity);
  const color = normalizeColor(value.color);
  return {
    type,
    visible: value.visible !== false,
    opacity: Math.max(0, Math.min(1, boundedNumber(value.opacity, 1, 0, 1))),
    ...(color ? { color } : {}),
    ...(typeof value.imageRef === "string" && value.imageRef ? { imageRef: value.imageRef } : {}),
    ...(variableId ? { variableId } : {}),
  };
}

function normalizePaints(value: unknown): DesignIrPaint[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizePaint).filter((paint): paint is DesignIrPaint => paint !== null);
}

function collectVariableAliases(value: unknown, output: Set<string>, depth = 0): void {
  if (depth > MAX_REFERENCE_SCAN_DEPTH || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectVariableAliases(item, output, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  const alias = variableAlias(value);
  if (alias) output.add(alias);
  for (const [key, item] of Object.entries(value)) {
    if (key !== "children") collectVariableAliases(item, output, depth + 1);
  }
}

function collectInteractionTargets(value: Record<string, unknown>): string[] {
  const targets = new Set<string>();
  const addTarget = (target: string) => targets.add(target.includes(":") ? target : target.replace(/-/g, ":"));
  const visit = (item: unknown, depth = 0): void => {
    if (depth > 8 || item === null || item === undefined) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (!isRecord(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (["destinationId", "transitionNodeID", "transitionNodeId", "nodeId"].includes(key) && typeof child === "string") {
        addTarget(child);
      } else if (key !== "children") visit(child, depth + 1);
    }
  };
  visit(value.interactions);
  visit(value.reactions);
  if (typeof value.transitionNodeID === "string") addTarget(value.transitionNodeID);
  if (typeof value.transitionNodeId === "string") addTarget(value.transitionNodeId);
  return [...targets].sort();
}

function textStyle(value: Record<string, unknown>): DesignIrNode["text"] | undefined {
  if (sourceType(value.type) !== "TEXT" && typeof value.characters !== "string") return undefined;
  const style = isRecord(value.style) ? value.style : {};
  const align = stringValue(style.textAlignHorizontal).toUpperCase();
  return {
    characters: stringValue(value.characters),
    ...(typeof style.fontFamily === "string" && style.fontFamily ? { fontFamily: style.fontFamily } : {}),
    ...(optionalNumber(style.fontWeight) !== undefined ? { fontWeight: boundedNumber(style.fontWeight, 400, 1, 1_000) } : {}),
    ...(optionalNumber(style.fontSize) !== undefined ? { fontSize: boundedNumber(style.fontSize, 14, 1, 1_000) } : {}),
    ...(optionalNumber(style.lineHeightPx) !== undefined ? { lineHeightPx: boundedNumber(style.lineHeightPx, 0, 0, 10_000) } : {}),
    ...(optionalNumber(style.letterSpacing) !== undefined ? { letterSpacing: boundedNumber(style.letterSpacing) } : {}),
    textAlign: align === "LEFT" ? "start" : align === "CENTER" ? "center" : align === "RIGHT" ? "end" : align === "JUSTIFIED" ? "justified" : "unknown",
  };
}

interface NormalizeCounter { value: number }

function normalizeNode(value: unknown, parentPath: string[], counter: NormalizeCounter, depth = 0): DesignIrNode | null {
  if (!isRecord(value) || depth > 128 || typeof value.id !== "string") return null;
  counter.value += 1;
  if (counter.value > MAX_IR_NODES) {
    throw new DesignToHarmonyError("ANALYSIS_TOO_LARGE", `The selected design contains more than ${MAX_IR_NODES} nodes`, {
      status: 413,
      stage: "analyze",
      details: { maxNodes: MAX_IR_NODES },
    });
  }
  const name = stringValue(value.name, value.id);
  const path = [...parentPath, name];
  const fills = normalizePaints(value.fills);
  const strokes = normalizePaints(value.strokes);
  const variables = new Set<string>();
  collectVariableAliases(value, variables);
  for (const paint of [...fills, ...strokes]) if (paint.variableId) variables.add(paint.variableId);
  const rawChildren = Array.isArray(value.children) ? value.children : [];
  const children = rawChildren
    .map((child) => normalizeNode(child, path, counter, depth + 1))
    .filter((child): child is DesignIrNode => child !== null);
  const type = sourceType(value.type);
  const normalizedText = textStyle(value);
  const rawEffects = Array.isArray(value.effects) ? value.effects : [];
  return {
    id: value.id,
    sourceId: value.id,
    sourcePath: path,
    name,
    sourceType: type,
    kind: nodeKind(type, value),
    visible: value.visible !== false,
    layout: normalizeLayout(value),
    opacity: Math.max(0, Math.min(1, boundedNumber(value.opacity, 1, 0, 1))),
    blendMode: stringValue(value.blendMode, "NORMAL").toUpperCase(),
    ...(optionalNumber(value.cornerRadius) !== undefined ? { cornerRadius: boundedNumber(value.cornerRadius, 0, 0, 100_000) } : {}),
    fills,
    strokes,
    effects: rawEffects.flatMap((effect) => isRecord(effect) && typeof effect.type === "string" && effect.visible !== false ? [effect.type.toUpperCase()] : []),
    ...(normalizedText ? { text: normalizedText } : {}),
    ...(typeof value.componentId === "string" && value.componentId ? { componentId: value.componentId } : {}),
    variableIds: [...variables].sort(),
    imageRefs: [...new Set([...fills, ...strokes].flatMap((paint) => paint.imageRef ? [paint.imageRef] : []))].sort(),
    interactionTargetIds: collectInteractionTargets(value),
    children,
  };
}

export function normalizeDesignNodes(input: {
  sourceImportId: string;
  sourceVersion: string;
  targetNodeIds: string[];
  payloads: DesignSourceNodePayload[];
}): NormalizedDesignIR {
  const counter = { value: 0 };
  const orderedPayloads = [...input.payloads].sort((left, right) => {
    const leftIndex = input.targetNodeIds.indexOf(left.id);
    const rightIndex = input.targetNodeIds.indexOf(right.id);
    if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    return left.id.localeCompare(right.id);
  });
  const roots = orderedPayloads
    .map((payload) => normalizeNode(payload.document, [], counter))
    .filter((node): node is DesignIrNode => node !== null);
  if (roots.length === 0) {
    throw new DesignToHarmonyError("ANALYSIS_FAILED", "The selected design nodes could not be normalized", { status: 422, stage: "analyze" });
  }
  const base = {
    schemaVersion: 1 as const,
    sourceImportId: input.sourceImportId,
    sourceVersion: input.sourceVersion,
    targetNodeIds: [...new Set(input.targetNodeIds)].sort(),
    roots,
    nodeCount: counter.value,
  };
  return { ...base, hash: stableDesignHash(base) };
}

export function flattenDesignIr(roots: DesignIrNode[]): DesignIrNode[] {
  const flattened: DesignIrNode[] = [];
  const visit = (node: DesignIrNode) => {
    flattened.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return flattened;
}
