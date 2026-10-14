import { createHash } from "node:crypto";

function normalizeStableValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => normalizeStableValue(item, seen));
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) throw new TypeError("Cannot serialize a circular design value");
  seen.add(value);
  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, item]) => {
        const next = normalizeStableValue(item, seen);
        return next === undefined ? [] : [[key, next]];
      }),
  );
  seen.delete(value);
  return normalized;
}

export function stableDesignJson(value: unknown): string {
  return JSON.stringify(normalizeStableValue(value, new Set()));
}

export function stableDesignHash(value: unknown): string {
  return createHash("sha256").update(stableDesignJson(value)).digest("hex");
}
