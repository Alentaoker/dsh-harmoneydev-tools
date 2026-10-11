import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { designToHarmonyDataRoot } from "./data-root";
import { getDesignRunOperationRegistry } from "./run-operations";

const PREVIEW_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const MAX_ENTRIES_PER_ROOT = 2_000;

function childOf(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return Boolean(child) && !child.startsWith("..") && !isAbsolute(child);
}

function removeOldChildren(root: string, maxAgeMs: number, activeRunIds: Set<string>, now: number): number {
  if (!existsSync(root)) return 0;
  const entries = readdirSync(root, { withFileTypes: true }).slice(0, MAX_ENTRIES_PER_ROOT);
  let removed = 0;
  for (const entry of entries) {
    if (activeRunIds.has(entry.name) || !/^[A-Za-z0-9._-]{8,160}$/.test(entry.name)) continue;
    const path = join(root, entry.name);
    if (!childOf(root, path)) continue;
    try {
      const details = lstatSync(path);
      if (details.isSymbolicLink() || now - statSync(path).mtimeMs <= maxAgeMs) continue;
      rmSync(path, { recursive: details.isDirectory(), force: true });
      removed += 1;
    } catch { /* cleanup is best effort and never blocks a design workflow */ }
  }
  return removed;
}

export function cleanupDesignToHarmonyCaches(options: { dataRoot?: string; now?: number } = {}): { removed: number } {
  const root = resolve(options.dataRoot ?? designToHarmonyDataRoot());
  if (!basename(root).toLowerCase().includes("design-to-harmony")) return { removed: 0 };
  const registry = getDesignRunOperationRegistry();
  const activeRunIds = new Set<string>();
  const previewsRoot = join(root, "previews");
  if (existsSync(previewsRoot)) {
    for (const entry of readdirSync(previewsRoot, { withFileTypes: true }).slice(0, MAX_ENTRIES_PER_ROOT)) {
      if (entry.isDirectory() && registry.get(entry.name)) activeRunIds.add(entry.name);
    }
  }
  const now = options.now ?? Date.now();
  return {
    removed: removeOldChildren(previewsRoot, PREVIEW_MAX_AGE_MS, activeRunIds, now)
      + removeOldChildren(join(root, "validations"), CACHE_MAX_AGE_MS, activeRunIds, now)
      + removeOldChildren(join(root, "asset-cache"), CACHE_MAX_AGE_MS, new Set(), now),
  };
}
