import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { allowFileRoot } from "../file-access";
import { designToHarmonyDataRoot } from "./data-root";
import { DesignToHarmonyError } from "./errors";
import { generateArkUiArtifacts, type GeneratedArtifactContent } from "./generator";
import { stableDesignHash, stableDesignJson } from "./stable-json";
import type {
  DesignPreviewFile,
  GeneratedArtifactRecord,
  GeneratedArtifactManifest,
  HarmonyUiPlan,
  NormalizedDesignIR,
} from "./types";
import type { ExportedDesignAsset } from "./generator";

const RUN_ID_PATTERN = /^run_[a-f0-9]{20}$/;
const PREVIEW_ID_PATTERN = /^preview_[a-f0-9]{20}$/;
const MAX_ARTIFACTS = 250;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

function validateId(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new DesignToHarmonyError("INVALID_ARGUMENT", `Invalid ${label}`, { status: 400, stage: "preview" });
  return value;
}

export function validatePreviewRelativePath(value: string): string {
  if (!value || value.length > 512 || value.includes("\0") || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "Invalid preview artifact path", { status: 400, stage: "preview" });
  }
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "Preview artifact path cannot escape its workspace", { status: 400, stage: "preview" });
  }
  return segments.join("/");
}

function ensureWithin(root: string, target: string): void {
  const relativePath = relative(resolve(root), resolve(target));
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return;
  throw new DesignToHarmonyError("PREVIEW_CONFLICT", "Preview path escaped its isolated workspace", { status: 409, stage: "preview" });
}

function validateManifest(value: unknown, expectedRunId?: string, expectedPreviewId?: string): GeneratedArtifactManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const manifest = value as Partial<GeneratedArtifactManifest>;
  if (manifest.schemaVersion !== 1
    || typeof manifest.id !== "string"
    || typeof manifest.runId !== "string"
    || typeof manifest.planId !== "string"
    || typeof manifest.sourceVersion !== "string"
    || typeof manifest.generatorVersion !== "string"
    || typeof manifest.irHash !== "string"
    || typeof manifest.planHash !== "string"
    || typeof manifest.hash !== "string"
    || !Array.isArray(manifest.artifacts)
    || !Array.isArray(manifest.assetPlan)
    || !Array.isArray(manifest.fallbackIssueIds)
    || typeof manifest.totalBytes !== "number") return undefined;
  if (manifest.artifacts.length === 0 || manifest.artifacts.length > MAX_ARTIFACTS
    || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > MAX_PREVIEW_BYTES
    || !manifest.fallbackIssueIds.every((id) => typeof id === "string" && id.length <= 256)
    || manifest.assetPlan.length > MAX_ARTIFACTS) return undefined;
  if (expectedRunId && manifest.runId !== expectedRunId) return undefined;
  if (expectedPreviewId && manifest.id !== expectedPreviewId) return undefined;
  try {
    validateId(manifest.runId, RUN_ID_PATTERN, "design run id");
    validateId(manifest.id, PREVIEW_ID_PATTERN, "design preview id");
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const artifact of manifest.artifacts) {
      if (!artifact || typeof artifact !== "object"
        || !["arkts", "media", "metadata"].includes(artifact.kind)
        || typeof artifact.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(artifact.mediaType)
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > MAX_ARTIFACT_BYTES
        || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || !Array.isArray(artifact.sourceNodeIds) || !artifact.sourceNodeIds.every((id) => typeof id === "string" && id.length <= 256)
        || artifact.managed !== true
        || (artifact.symbolName !== undefined && (typeof artifact.symbolName !== "string" || artifact.symbolName.length > 256))) return undefined;
      const path = validatePreviewRelativePath(artifact.relativePath);
      if (paths.has(path)) return undefined;
      paths.add(path);
      totalBytes += artifact.bytes;
    }
    if (totalBytes !== manifest.totalBytes) return undefined;
    for (const asset of manifest.assetPlan) {
      if (!asset || typeof asset !== "object"
        || typeof asset.sourceNodeId !== "string"
        || typeof asset.sourceRef !== "string"
        || typeof asset.resourceName !== "string"
        || !["source_render_png", "placeholder_svg"].includes(asset.strategy)
        || (asset.fallbackReason !== undefined && typeof asset.fallbackReason !== "string")) return undefined;
      validatePreviewRelativePath(asset.relativePath);
    }
  } catch {
    return undefined;
  }
  const { id, hash, ...base } = manifest;
  return stableDesignHash(base) === hash && id === `preview_${hash.slice(0, 20)}`
    ? manifest as GeneratedArtifactManifest
    : undefined;
}

export class DesignPreviewWorkspace {
  readonly root: string;

  constructor(dataRoot = designToHarmonyDataRoot()) {
    this.root = join(resolve(dataRoot), "previews");
  }

  private runRoot(runId: string): string {
    return join(this.root, validateId(runId, RUN_ID_PATTERN, "design run id"));
  }

  private previewRoot(runId: string, previewId: string): string {
    return join(this.runRoot(runId), validateId(previewId, PREVIEW_ID_PATTERN, "design preview id"));
  }

  private manifestPath(runId: string, previewId: string): string {
    return join(this.previewRoot(runId, previewId), "manifest.json");
  }

  private cleanStaging(runRoot: string, stagingRoot: string): void {
    const child = relative(resolve(runRoot), resolve(stagingRoot));
    if (!/^\.staging-preview_[a-f0-9]{20}-[a-f0-9-]+$/i.test(child)) {
      throw new DesignToHarmonyError("PREVIEW_CONFLICT", "Refused to clean an unexpected preview path", { status: 409, stage: "preview" });
    }
    if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
  }

  readManifest(runId: string, previewId: string): GeneratedArtifactManifest | undefined {
    const manifestPath = this.manifestPath(runId, previewId);
    if (!existsSync(manifestPath)) return undefined;
    try {
      if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) return undefined;
      const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")), runId, previewId);
      if (manifest) allowFileRoot(join(this.previewRoot(runId, previewId), "files"));
      return manifest;
    } catch {
      return undefined;
    }
  }

  write(runId: string, manifest: GeneratedArtifactManifest, artifacts: GeneratedArtifactContent[]): GeneratedArtifactManifest {
    validateId(runId, RUN_ID_PATTERN, "design run id");
    if (manifest.runId !== runId || validateManifest(manifest, runId, manifest.id) === undefined) {
      throw new DesignToHarmonyError("GENERATION_FAILED", "Generated preview manifest failed its integrity check", { status: 500, stage: "preview" });
    }
    if (artifacts.length === 0 || artifacts.length > MAX_ARTIFACTS) {
      throw new DesignToHarmonyError("GENERATION_FAILED", "Generated preview contains an invalid number of artifacts", { status: 422, stage: "preview" });
    }
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const item of artifacts) {
      const relativePath = validatePreviewRelativePath(item.record.relativePath);
      if (paths.has(relativePath)) throw new DesignToHarmonyError("GENERATION_FAILED", "Generated preview contains duplicate artifact paths", { status: 422, stage: "preview" });
      paths.add(relativePath);
      const bytes = item.content.byteLength;
      const sha256 = createHash("sha256").update(item.content).digest("hex");
      if (bytes !== item.record.bytes || sha256 !== item.record.sha256 || bytes > MAX_ARTIFACT_BYTES) {
        throw new DesignToHarmonyError("GENERATION_FAILED", "Generated artifact exceeds its integrity or size limit", { status: 413, stage: "preview" });
      }
      totalBytes += bytes;
    }
    if (totalBytes !== manifest.totalBytes || totalBytes > MAX_PREVIEW_BYTES) {
      throw new DesignToHarmonyError("GENERATION_FAILED", "Generated preview exceeds its total size limit", { status: 413, stage: "preview" });
    }

    const runRoot = this.runRoot(runId);
    const targetRoot = this.previewRoot(runId, manifest.id);
    const existing = this.readManifest(runId, manifest.id);
    if (existing) {
      if (existing.hash !== manifest.hash) throw new DesignToHarmonyError("PREVIEW_CONFLICT", "A preview with the same id has different content", { status: 409, stage: "preview" });
      return existing;
    }
    if (existsSync(targetRoot)) throw new DesignToHarmonyError("PREVIEW_CONFLICT", "An incomplete preview already occupies the generated id", { status: 409, stage: "preview" });

    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = join(runRoot, `.staging-${manifest.id}-${randomUUID()}`);
    ensureWithin(runRoot, stagingRoot);
    mkdirSync(stagingRoot, { mode: 0o700 });
    try {
      const filesRoot = join(stagingRoot, "files");
      for (const item of artifacts) {
        const outputPath = join(filesRoot, ...validatePreviewRelativePath(item.record.relativePath).split("/"));
        ensureWithin(filesRoot, outputPath);
        mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
        writeFileSync(outputPath, item.content, { flag: "wx", mode: 0o600, flush: true });
      }
      writeFileSync(join(stagingRoot, "manifest.json"), `${stableDesignJson(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
      renameSync(stagingRoot, targetRoot);
      allowFileRoot(join(targetRoot, "files"));
      return manifest;
    } catch (error) {
      this.cleanStaging(runRoot, stagingRoot);
      throw error;
    }
  }

  generate(
    runId: string,
    ir: NormalizedDesignIR,
    plan: HarmonyUiPlan,
    assets: readonly ExportedDesignAsset[] = [],
    assetFallbackReasons: ReadonlyMap<string, string> = new Map(),
  ): GeneratedArtifactManifest {
    const output = generateArkUiArtifacts(runId, ir, plan, { assets, assetFallbackReasons });
    return this.write(runId, output.manifest, output.artifacts);
  }

  readFile(runId: string, previewId: string, relativePathValue: string): DesignPreviewFile {
    const manifest = this.readManifest(runId, previewId);
    if (!manifest) throw new DesignToHarmonyError("PREVIEW_NOT_FOUND", "Generated preview was not found", { status: 404, stage: "preview" });
    const relativePath = validatePreviewRelativePath(relativePathValue);
    const artifact = manifest.artifacts.find((item) => item.relativePath === relativePath);
    if (!artifact) throw new DesignToHarmonyError("PREVIEW_NOT_FOUND", "Generated artifact was not found in this preview", { status: 404, stage: "preview" });
    const filesRoot = join(this.previewRoot(runId, previewId), "files");
    const absolutePath = join(filesRoot, ...relativePath.split("/"));
    ensureWithin(filesRoot, absolutePath);
    try {
      const details = lstatSync(absolutePath);
      if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_ARTIFACT_BYTES) throw new Error("invalid preview file");
      const realPath = realpathSync(absolutePath);
      ensureWithin(realpathSync(filesRoot), realPath);
      const bytes = readFileSync(realPath);
      if (bytes.byteLength !== artifact.bytes) throw new Error("preview file changed");
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("preview file hash changed");
      const text = artifact.kind !== "media" || artifact.mediaType === "image/svg+xml";
      return { artifact, encoding: text ? "utf8" : "base64", content: bytes.toString(text ? "utf8" : "base64"), absolutePath: realPath };
    } catch (error) {
      if (error instanceof DesignToHarmonyError) throw error;
      throw new DesignToHarmonyError("PREVIEW_CONFLICT", "Generated artifact failed its integrity check", { status: 409, stage: "preview", cause: error });
    }
  }

  readBytes(runId: string, previewId: string, relativePathValue: string): { artifact: GeneratedArtifactRecord; data: Buffer; absolutePath: string } {
    const file = this.readFile(runId, previewId, relativePathValue);
    return {
      artifact: file.artifact,
      data: Buffer.from(file.content, file.encoding),
      absolutePath: file.absolutePath,
    };
  }
}

declare global {
  var __pioraDesignPreviewWorkspace: DesignPreviewWorkspace | undefined;
}

export function getDesignPreviewWorkspace(): DesignPreviewWorkspace {
  return globalThis.__pioraDesignPreviewWorkspace ??= new DesignPreviewWorkspace();
}

export function resetDesignPreviewWorkspaceForTests(): void {
  globalThis.__pioraDesignPreviewWorkspace = undefined;
}
