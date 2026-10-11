import { createHash } from "node:crypto";
import { flattenDesignIr } from "./normalize";
import { planDesignAssets } from "./asset-planner";
import { buildArkUiAst } from "./arkui-ast";
import { printArkUiFile } from "./arkui-printer";
import { stableDesignHash } from "./stable-json";
import type {
  DesignAssetPlanItem,
  GeneratedArtifactManifest,
  GeneratedArtifactRecord,
  HarmonyUiPlan,
  NormalizedDesignIR,
} from "./types";

export const ARKUI_GENERATOR_VERSION = "piora-arkui-v2";

export interface GeneratedArtifactContent {
  record: GeneratedArtifactRecord;
  content: Buffer;
}

export interface ExportedDesignAsset {
  sourceNodeId: string;
  mediaType: "image/png";
  data: Buffer;
  fallbackReason?: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function placeholderSvg(asset: DesignAssetPlanItem, ir: NormalizedDesignIR): string {
  const node = flattenDesignIr(ir.roots).find((candidate) => candidate.id === asset.sourceNodeId);
  const width = Math.max(1, Math.min(4096, Math.round(node?.layout.width ?? 320)));
  const height = Math.max(1, Math.min(4096, Math.round(node?.layout.height ?? 180)));
  const label = xmlEscape(node?.name ?? asset.sourceNodeId);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "  <!-- Deterministic preview placeholder. The original design asset has not been exported yet. -->",
    `  <rect width="${width}" height="${height}" rx="12" fill="#E9ECF2"/>`,
    `  <text x="${Math.round(width / 2)}" y="${Math.round(height / 2)}" text-anchor="middle" dominant-baseline="middle" fill="#667085" font-family="sans-serif" font-size="14">${label}</text>`,
    "</svg>",
    "",
  ].join("\n");
}

function artifact(input: Omit<GeneratedArtifactRecord, "bytes" | "sha256" | "managed">, content: string | Uint8Array): GeneratedArtifactContent {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return {
    record: {
      ...input,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      managed: true,
    },
    content: bytes,
  };
}

export function generateArkUiArtifacts(
  runId: string,
  ir: NormalizedDesignIR,
  plan: HarmonyUiPlan,
  options: { assets?: readonly ExportedDesignAsset[]; assetFallbackReasons?: ReadonlyMap<string, string> } = {},
): {
  manifest: GeneratedArtifactManifest;
  artifacts: GeneratedArtifactContent[];
} {
  const exportedAssets = new Map((options.assets ?? []).map((item) => [item.sourceNodeId, item]));
  const fallbackReasons = new Map(options.assetFallbackReasons ?? []);
  for (const item of options.assets ?? []) if (item.fallbackReason) fallbackReasons.set(item.sourceNodeId, item.fallbackReason);
  const assetPlan = planDesignAssets(ir, plan, new Set(exportedAssets.keys()), fallbackReasons);
  const astFiles = buildArkUiAst(ir, plan, assetPlan);
  const artifacts: GeneratedArtifactContent[] = [
    ...astFiles.map((file) => artifact({
      relativePath: file.relativePath,
      kind: "arkts" as const,
      mediaType: "text/x-arkts",
      sourceNodeIds: file.sourceNodeIds,
      symbolName: file.symbolName,
    }, printArkUiFile(file, ARKUI_GENERATOR_VERSION))),
    ...assetPlan.map((asset) => {
      const exported = exportedAssets.get(asset.sourceNodeId);
      return artifact({
        relativePath: asset.relativePath,
        kind: "media" as const,
        mediaType: exported?.mediaType ?? "image/svg+xml",
        sourceNodeIds: [asset.sourceNodeId],
      }, exported?.data ?? placeholderSvg(asset, ir));
    }),
  ].sort((left, right) => left.record.relativePath.localeCompare(right.record.relativePath));
  const manifestBase = {
    schemaVersion: 1 as const,
    runId,
    planId: plan.id,
    sourceVersion: plan.sourceVersion,
    generatorVersion: ARKUI_GENERATOR_VERSION,
    irHash: ir.hash,
    planHash: plan.hash,
    artifacts: artifacts.map((item) => item.record),
    assetPlan,
    fallbackIssueIds: plan.issues.filter((issue) => issue.severity !== "blocking").map((issue) => issue.id).sort(),
    totalBytes: artifacts.reduce((total, item) => total + item.record.bytes, 0),
  };
  const hash = stableDesignHash(manifestBase);
  return {
    manifest: { ...manifestBase, id: `preview_${hash.slice(0, 20)}`, hash },
    artifacts,
  };
}
