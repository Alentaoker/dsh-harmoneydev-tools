import { HarmonyError } from "./errors";
import type { HarmonyUiNode, HarmonyUiSelector } from "./types";

const MAX_SELECTOR_DEPTH = 3;
const MAX_SELECTOR_TEXT = 500;

function normalized(value: string | undefined): string | undefined {
  const result = value?.replace(/\s+/g, " ").trim();
  return result || undefined;
}

function validateString(value: unknown, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !normalized(value) || value.length > MAX_SELECTOR_TEXT || value.includes("\0")) {
    throw new HarmonyError("INVALID_ARGUMENT", `${name} must be a non-empty string of at most ${MAX_SELECTOR_TEXT} characters`);
  }
}

export function validateHarmonySelector(selector: HarmonyUiSelector, depth = 0): void {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw new HarmonyError("INVALID_ARGUMENT", "A valid Harmony UI selector is required");
  }
  if (depth > MAX_SELECTOR_DEPTH) {
    throw new HarmonyError("INVALID_ARGUMENT", `Harmony UI selectors support at most ${MAX_SELECTOR_DEPTH} relationship levels`);
  }
  for (const key of ["id", "text", "type", "hint", "description", "inWindow"] as const) {
    validateString(selector[key], `selector.${key}`);
  }
  if (selector.match !== undefined && !["exact", "contains", "starts_with", "ends_with"].includes(selector.match)) {
    throw new HarmonyError("INVALID_ARGUMENT", "selector.match is invalid");
  }
  for (const key of ["clickable", "scrollable", "enabled", "focused", "selected", "checked", "visible"] as const) {
    if (selector[key] !== undefined && typeof selector[key] !== "boolean") {
      throw new HarmonyError("INVALID_ARGUMENT", `selector.${key} must be a boolean`);
    }
  }
  if (!selector.id && !selector.text && !selector.type && !selector.hint && !selector.description && !selector.inWindow
    && selector.clickable === undefined && selector.scrollable === undefined && selector.focused === undefined
    && selector.selected === undefined && selector.checked === undefined && selector.enabled === undefined
    && selector.visible === undefined) {
    throw new HarmonyError("INVALID_ARGUMENT", "A selector requires an id, text, type, hint, description, or semantic state");
  }
  if (selector.index !== undefined && (!Number.isSafeInteger(selector.index) || selector.index < 0 || selector.index > 10_000)) {
    throw new HarmonyError("INVALID_ARGUMENT", "selector.index must be an integer between 0 and 10000");
  }
  for (const relation of [selector.within, selector.before, selector.after]) {
    if (relation !== undefined) validateHarmonySelector(relation, depth + 1);
  }
}

function stringMatches(actual: string | undefined, expected: string | undefined, mode: HarmonyUiSelector["match"]): boolean {
  if (expected === undefined) return true;
  const left = normalized(actual)?.toLocaleLowerCase();
  const right = normalized(expected)?.toLocaleLowerCase();
  if (!left || !right) return false;
  if (mode === "contains") return left.includes(right);
  if (mode === "starts_with") return left.startsWith(right);
  if (mode === "ends_with") return left.endsWith(right);
  return left === right;
}

function directMatch(node: HarmonyUiNode, selector: HarmonyUiSelector): boolean {
  if (!stringMatches(node.id, selector.id, selector.match)) return false;
  if (!stringMatches(node.text, selector.text, selector.match)) return false;
  if (!stringMatches(node.type, selector.type, selector.match)) return false;
  if (!stringMatches(node.hint, selector.hint, selector.match)) return false;
  if (!stringMatches(node.description, selector.description, selector.match)) return false;
  for (const key of ["clickable", "scrollable", "enabled", "focused", "selected", "checked", "visible"] as const) {
    if (selector[key] !== undefined && node[key] !== selector[key]) return false;
  }
  return true;
}

function relatedMatch(
  nodes: readonly HarmonyUiNode[],
  nodeIndex: number,
  selector: HarmonyUiSelector,
  byRef: Map<string, number>,
  depth: number,
): boolean {
  if (depth > MAX_SELECTOR_DEPTH) return false;
  const node = nodes[nodeIndex];
  if (!node || !directMatch(node, selector)) return false;

  if (selector.within) {
    let parentRef = node.parentRef;
    let matched = false;
    const visited = new Set<string>();
    while (parentRef && !visited.has(parentRef)) {
      visited.add(parentRef);
      const parentIndex = byRef.get(parentRef);
      if (parentIndex === undefined) break;
      if (relatedMatch(nodes, parentIndex, selector.within, byRef, depth + 1)) {
        matched = true;
        break;
      }
      parentRef = nodes[parentIndex]?.parentRef;
    }
    if (!matched) return false;
  }

  if (selector.before && !nodes.some((_, index) => index > nodeIndex
    && relatedMatch(nodes, index, selector.before!, byRef, depth + 1))) return false;
  if (selector.after && !nodes.some((_, index) => index < nodeIndex
    && relatedMatch(nodes, index, selector.after!, byRef, depth + 1))) return false;
  return true;
}

export function findHarmonyNodes(nodes: readonly HarmonyUiNode[], selector: HarmonyUiSelector): HarmonyUiNode[] {
  validateHarmonySelector(selector);
  const byRef = new Map(nodes.map((node, index) => [node.ref, index]));
  return nodes.filter((_, index) => relatedMatch(nodes, index, selector, byRef, 0));
}

export function resolveHarmonyNode(nodes: readonly HarmonyUiNode[], selector: HarmonyUiSelector): HarmonyUiNode {
  const matches = findHarmonyNodes(nodes, selector);
  if (selector.index !== undefined) {
    const indexed = matches[selector.index];
    if (indexed) return indexed;
    throw new HarmonyError("UI_TARGET_NOT_FOUND", "The requested UI selector index was not found", {
      details: { matchCount: matches.length, requestedIndex: selector.index },
      retryable: true,
    });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new HarmonyError("UI_TARGET_NOT_FOUND", "No UI element matched the requested selector", { retryable: true });
  }
  throw new HarmonyError("UI_TARGET_AMBIGUOUS", "The UI selector matched more than one element; add an id, type, relationship, or index", {
    details: {
      matchCount: matches.length,
      candidates: matches.slice(0, 8).map((node) => ({ id: node.id, type: node.type, clickable: node.clickable })),
    },
    retryable: true,
  });
}

export function harmonyNodeCenter(node: HarmonyUiNode): { x: number; y: number } {
  if (!node.bounds) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The selected UI element has no actionable bounds");
  if (node.enabled === false || node.visible === false) {
    throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The selected UI element is disabled or not visible");
  }
  return {
    x: Math.round((node.bounds.left + node.bounds.right) / 2),
    y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
  };
}
