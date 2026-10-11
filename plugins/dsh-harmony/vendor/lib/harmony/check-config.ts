import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import type { HarmonyCheckConfig } from "./check-types";

export const DEFAULT_HARMONY_CHECK_CONFIG: HarmonyCheckConfig = {
  arktsEnabled: true,
  lintEnabled: true,
  checkAfterAgentEdits: true,
  maxAgentIterations: 3,
  timeoutMs: 45_000,
  products: {},
};

export function harmonyCheckConfigPath(root = getAgentDir()): string {
  return join(root, "piora", "harmony-check.json");
}

function optionalAbsolutePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const path = value.trim();
  if (!isAbsolute(path)) throw new Error("DevEco and SDK paths must be absolute");
  return resolve(path);
}

function normalizeProducts(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([root, product]) => {
    if (!isAbsolute(root) || typeof product !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(product)) return [];
    return [[resolve(root), product]];
  }).slice(0, 100));
}

export function normalizeHarmonyCheckConfig(value: unknown): HarmonyCheckConfig {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const maxAgentIterations = Number.isInteger(source.maxAgentIterations)
    ? Math.min(5, Math.max(1, source.maxAgentIterations as number))
    : DEFAULT_HARMONY_CHECK_CONFIG.maxAgentIterations;
  const timeoutMs = Number.isFinite(source.timeoutMs)
    ? Math.min(90_000, Math.max(10_000, Math.round(source.timeoutMs as number)))
    : DEFAULT_HARMONY_CHECK_CONFIG.timeoutMs;
  return {
    arktsEnabled: source.arktsEnabled !== false,
    lintEnabled: source.lintEnabled !== false,
    checkAfterAgentEdits: source.checkAfterAgentEdits !== false,
    maxAgentIterations,
    timeoutMs,
    ...(optionalAbsolutePath(source.studioPath) ? { studioPath: optionalAbsolutePath(source.studioPath) } : {}),
    products: normalizeProducts(source.products),
  };
}

export function readHarmonyCheckConfig(root = getAgentDir()): HarmonyCheckConfig {
  try {
    return normalizeHarmonyCheckConfig(JSON.parse(readFileSync(harmonyCheckConfigPath(root), "utf8")));
  } catch {
    return { ...DEFAULT_HARMONY_CHECK_CONFIG, products: {} };
  }
}

export function writeHarmonyCheckConfig(value: unknown, root = getAgentDir()): HarmonyCheckConfig {
  const config = normalizeHarmonyCheckConfig(value);
  const path = harmonyCheckConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function configuredProduct(config: HarmonyCheckConfig, projectRoot: string): string | undefined {
  const target = resolve(projectRoot);
  const key = Object.keys(config.products).find((candidate) => {
    const resolved = resolve(candidate);
    return process.platform === "win32" ? resolved.toLowerCase() === target.toLowerCase() : resolved === target;
  });
  return key ? config.products[key] : undefined;
}
