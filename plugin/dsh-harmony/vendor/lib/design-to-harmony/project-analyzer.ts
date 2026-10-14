import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import JSON5 from "json5";
import type { HarmonyProjectComponent, HarmonyProjectInventory, HarmonyProjectModule } from "./types";

const MAX_SCAN_FILES = 4_000;
const MAX_SCAN_DEPTH = 7;
const SKIP_DIRECTORIES = new Set([".git", ".next", "node_modules", "oh_modules", "build", ".preview", ".idea"]);

function portablePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function walkFiles(root: string, options: { maxDepth: number; extension?: string }): { files: string[]; scanned: number; truncated: boolean } {
  const files: string[] = [];
  let scanned = 0;
  let truncated = false;
  const visit = (directory: string, depth: number) => {
    if (depth > options.maxDepth || truncated) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(directory, entry.name);
      scanned += 1;
      if (scanned > MAX_SCAN_FILES) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) visit(fullPath, depth + 1);
      } else if (entry.isFile() && (!options.extension || entry.name.toLowerCase().endsWith(options.extension))) {
        files.push(fullPath);
      }
    }
  };
  visit(root, 0);
  return { files, scanned: Math.min(scanned, MAX_SCAN_FILES), truncated };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readJson5(path: string): Record<string, unknown> | undefined {
  try { return record(JSON5.parse(readFileSync(path, "utf8"))); } catch { return undefined; }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function moduleFromManifest(projectRoot: string, manifestPath: string): HarmonyProjectModule {
  const mainDirectory = dirname(manifestPath);
  const sourceDirectory = dirname(mainDirectory);
  const moduleRoot = dirname(sourceDirectory);
  const etsRoot = join(mainDirectory, "ets");
  const resourceRoot = join(mainDirectory, "resources");
  const componentScan = existsSync(etsRoot) ? walkFiles(etsRoot, { maxDepth: 8, extension: ".ets" }) : { files: [], scanned: 0, truncated: false };
  const components: HarmonyProjectComponent[] = componentScan.files.map((filePath) => ({
    name: basename(filePath, ".ets"),
    relativePath: portablePath(relative(projectRoot, filePath)),
  }));
  const manifest = readJson5(manifestPath);
  const moduleConfig = record(manifest?.module);
  const abilities = Array.isArray(moduleConfig?.abilities) ? moduleConfig.abilities.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  const moduleProfile = readJson5(join(moduleRoot, "build-profile.json5"));
  const targets = Array.isArray(moduleProfile?.targets)
    ? moduleProfile.targets.map(record).map((target) => stringValue(target?.name)).filter((value): value is string => Boolean(value))
    : [];
  return {
    name: stringValue(moduleConfig?.name) ?? basename(moduleRoot),
    relativePath: portablePath(relative(projectRoot, moduleRoot)) || ".",
    ...(existsSync(etsRoot) ? { sourceRoot: portablePath(relative(projectRoot, etsRoot)) } : {}),
    ...(existsSync(resourceRoot) ? { resourceRoot: portablePath(relative(projectRoot, resourceRoot)) } : {}),
    targets: targets.length ? [...new Set(targets)].sort() : ["default"],
    ...(stringValue(moduleConfig?.type) ? { moduleType: stringValue(moduleConfig?.type) } : {}),
    ...(stringValue(moduleConfig?.mainElement) ? { mainElement: stringValue(moduleConfig?.mainElement) } : {}),
    ...(stringValue(abilities[0]?.name) ? { abilityName: stringValue(abilities[0]?.name) } : {}),
    components,
  };
}

export function analyzeHarmonyProject(projectRootValue: string): HarmonyProjectInventory {
  const projectRoot = resolve(projectRootValue);
  const scan = walkFiles(projectRoot, { maxDepth: MAX_SCAN_DEPTH });
  const manifests = scan.files.filter((filePath) => {
    const relativePath = `/${portablePath(relative(projectRoot, filePath)).toLowerCase()}`;
    return basename(filePath).toLowerCase() === "module.json5" && relativePath.endsWith("/src/main/module.json5");
  });
  const modules = manifests
    .map((manifest) => moduleFromManifest(projectRoot, manifest))
    .sort((left, right) => left.name.localeCompare(right.name) || left.relativePath.localeCompare(right.relativePath));
  const selectedModule = modules.find((module) => module.name.toLowerCase() === "entry")?.name ?? modules[0]?.name;
  const selectedModuleConfig = modules.find((module) => module.name === selectedModule);
  const buildProfile = readJson5(join(projectRoot, "build-profile.json5"));
  const app = record(buildProfile?.app);
  const products = Array.isArray(app?.products)
    ? app.products.map(record).map((product) => stringValue(product?.name)).filter((value): value is string => Boolean(value))
    : [];
  const appScope = readJson5(join(projectRoot, "AppScope", "app.json5"));
  const appConfig = record(appScope?.app);
  return {
    schemaVersion: 1,
    projectRoot,
    modules,
    ...(selectedModule ? { selectedModule } : {}),
    ...(selectedModuleConfig?.targets[0] ? { selectedTarget: selectedModuleConfig.targets[0] } : {}),
    products: products.length ? [...new Set(products)].sort() : ["default"],
    selectedProduct: products[0] ?? "default",
    ...(stringValue(app?.compileSdkVersion) ? { compileSdkVersion: stringValue(app?.compileSdkVersion) } : {}),
    ...(stringValue(app?.compatibleSdkVersion) ? { compatibleSdkVersion: stringValue(app?.compatibleSdkVersion) } : {}),
    ...(stringValue(appConfig?.bundleName) ? { bundleName: stringValue(appConfig?.bundleName) } : {}),
    scannedFiles: scan.scanned,
    truncated: scan.truncated,
  };
}
