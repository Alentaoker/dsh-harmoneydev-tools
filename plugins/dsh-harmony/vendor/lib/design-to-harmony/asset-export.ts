import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { designToHarmonyDataRoot } from "./data-root";
import { DesignToHarmonyError } from "./errors";
import { planDesignAssets } from "./asset-planner";
import type { ExportedDesignAsset } from "./generator";
import type { DesignSourceAdapter } from "./source-adapter";
import type { DesignSourceRef, HarmonyUiPlan, NormalizedDesignIR } from "./types";

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 24 * 1024 * 1024;
const MAX_ASSET_PIXELS = 32_000_000;
const DOWNLOAD_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 3;

export interface DesignAssetExportBatch {
  assets: ExportedDesignAsset[];
  fallbackReasons: Map<string, string>;
  cacheHits: number;
}

export interface DesignReferenceExport {
  nodeId: string;
  path?: string;
  data?: Buffer;
  error?: string;
}

type FetchLike = typeof fetch;

function cacheKey(ref: DesignSourceRef, version: string, nodeId: string): string {
  return createHash("sha256")
    .update("piora-design-render-png-v1\0")
    .update(ref.provider).update("\0").update(ref.fileKey).update("\0")
    .update(version).update("\0").update(nodeId)
    .digest("hex");
}

function pngDimensions(data: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (data.byteLength < 24 || !data.subarray(0, 8).equals(signature) || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned an invalid PNG render", { status: 502, stage: "source" });
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (!width || !height || width * height > MAX_ASSET_PIXELS) {
    throw new DesignToHarmonyError("SOURCE_RESPONSE_TOO_LARGE", "Rendered design asset exceeds the 32-megapixel limit", { status: 413, stage: "source" });
  }
  return { width, height };
}

function trustedRenderUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned an invalid asset URL", { status: 502, stage: "source" });
  }
  const host = url.hostname.toLowerCase();
  const trusted = host === "figma.com" || host.endsWith(".figma.com")
    || host === "amazonaws.com" || host.endsWith(".amazonaws.com")
    || host === "cloudfront.net" || host.endsWith(".cloudfront.net");
  if (url.protocol !== "https:" || !trusted || url.username || url.password) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned an untrusted asset URL", { status: 502, stage: "source" });
  }
  return url;
}

async function responseBytes(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    throw new DesignToHarmonyError("SOURCE_RESPONSE_TOO_LARGE", "Rendered design asset exceeds the download limit", { status: 413, stage: "source" });
  }
  if (!response.body) throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned an empty asset", { status: 502, stage: "source" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DesignToHarmonyError("SOURCE_RESPONSE_TOO_LARGE", "Rendered design asset exceeds the download limit", { status: 413, stage: "source" });
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function downloadPng(value: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<Buffer> {
  let url = trustedRenderUrl(value);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException("Asset download timed out", "TimeoutError")), DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "image/png" },
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === MAX_REDIRECTS) throw new DesignToHarmonyError("SOURCE_REQUEST_FAILED", "Figma asset redirected too many times", { status: 502, retryable: true, stage: "source" });
        const location = response.headers.get("location");
        if (!location) throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma asset redirect is missing a location", { status: 502, stage: "source" });
        url = trustedRenderUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new DesignToHarmonyError("SOURCE_REQUEST_FAILED", `Figma asset download failed with status ${response.status}`, { status: 502, retryable: response.status >= 500, stage: "source" });
      const data = await responseBytes(response);
      pngDimensions(data);
      return data;
    }
    throw new DesignToHarmonyError("SOURCE_REQUEST_FAILED", "Figma asset download failed", { status: 502, retryable: true, stage: "source" });
  } catch (error) {
    if (error instanceof DesignToHarmonyError) throw error;
    if (controller.signal.aborted) {
      throw new DesignToHarmonyError("SOURCE_ABORTED", signal?.aborted ? "Design generation was cancelled" : "Figma asset download timed out", { status: signal?.aborted ? 499 : 504, retryable: true, stage: "source", cause: error });
    }
    throw new DesignToHarmonyError("SOURCE_REQUEST_FAILED", "Unable to download a rendered design asset", { status: 502, retryable: true, stage: "source", cause: error });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function downloadImageAsPng(value: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<Buffer> {
  let url = trustedRenderUrl(value);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException("Image download timed out", "TimeoutError")), DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await fetchImpl(url, { method: "GET", headers: { Accept: "image/png,image/jpeg,image/webp" }, cache: "no-store", redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === MAX_REDIRECTS) throw new DesignToHarmonyError("SOURCE_REQUEST_FAILED", "Figma image fill redirected too many times", { status: 502, retryable: true, stage: "source" });
        const location = response.headers.get("location");
        if (!location) throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma image fill redirect is missing a location", { status: 502, stage: "source" });
        url = trustedRenderUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new DesignToHarmonyError("SOURCE_REQUEST_FAILED", `Figma image fill download failed with status ${response.status}`, { status: 502, retryable: response.status >= 500, stage: "source" });
      const source = await responseBytes(response);
      const metadata = await sharp(source, { limitInputPixels: MAX_ASSET_PIXELS }).metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_ASSET_PIXELS) throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned an invalid image fill", { status: 502, stage: "source" });
      const png = await sharp(source, { limitInputPixels: MAX_ASSET_PIXELS }).png({ compressionLevel: 9 }).toBuffer();
      if (png.byteLength > MAX_ASSET_BYTES) throw new DesignToHarmonyError("SOURCE_RESPONSE_TOO_LARGE", "Converted image fill exceeds the asset limit", { status: 413, stage: "source" });
      pngDimensions(png);
      return png;
    }
    throw new DesignToHarmonyError("SOURCE_REQUEST_FAILED", "Figma image fill download failed", { status: 502, retryable: true, stage: "source" });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function writePrivateBufferAtomic(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, data, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function readCachedPng(path: string): Buffer | undefined {
  try {
    const details = statSync(path);
    if (!details.isFile() || details.size <= 0 || details.size > MAX_ASSET_BYTES) return undefined;
    const data = readFileSync(path);
    pngDimensions(data);
    return data;
  } catch {
    return undefined;
  }
}

export async function exportDesignAssets(input: {
  adapter: DesignSourceAdapter;
  source: DesignSourceRef;
  sourceVersion: string;
  ir: NormalizedDesignIR;
  plan: HarmonyUiPlan;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  dataRoot?: string;
}): Promise<DesignAssetExportBatch> {
  const planned = planDesignAssets(input.ir, input.plan);
  const nodeIds = [...new Set(planned.map((item) => item.sourceNodeId))].sort();
  if (!nodeIds.length) return { assets: [], fallbackReasons: new Map(), cacheHits: 0 };
  const cacheRoot = join(resolve(input.dataRoot ?? designToHarmonyDataRoot()), "asset-cache");
  const assets: ExportedDesignAsset[] = [];
  const missing: string[] = [];
  let cacheHits = 0;
  for (const nodeId of nodeIds) {
    const cached = readCachedPng(join(cacheRoot, `${cacheKey(input.source, input.sourceVersion, nodeId)}.png`));
    if (cached) {
      assets.push({ sourceNodeId: nodeId, mediaType: "image/png", data: cached });
      cacheHits += 1;
    } else missing.push(nodeId);
  }
  const fallbackReasons = new Map<string, string>();
  if (missing.length) {
    const plannedByNode = new Map(planned.map((item) => [item.sourceNodeId, item]));
    const fillUrls = new Map<string, string>();
    if (input.adapter.getImageFills) {
      try {
        for (const fill of await input.adapter.getImageFills(input.source, input.signal)) if (fill.url) fillUrls.set(fill.imageRef, fill.url);
      } catch { /* node rendering remains a safe fallback when fill metadata is unavailable */ }
    }
    const renderMissing = missing.filter((nodeId) => !fillUrls.has(plannedByNode.get(nodeId)?.sourceRef ?? ""));
    let renders: Awaited<ReturnType<DesignSourceAdapter["exportAssets"]>> = [];
    try {
      renders = renderMissing.length
        ? await input.adapter.exportAssets(input.source, renderMissing.map((nodeId) => ({ nodeId, format: "png" as const, scale: 1 })), input.signal)
        : [];
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The design source could not render this asset";
      for (const nodeId of renderMissing) fallbackReasons.set(nodeId, reason);
    }
    const byNode = new Map(renders.map((render) => [render.nodeId, render.url]));
    let total = assets.reduce((sum, item) => sum + item.data.byteLength, 0);
    for (const nodeId of missing) {
      const fillUrl = fillUrls.get(plannedByNode.get(nodeId)?.sourceRef ?? "");
      const url = byNode.get(nodeId);
      if (!fillUrl && !url) {
        fallbackReasons.set(nodeId, "The design source did not return a render for this node");
        continue;
      }
      try {
        const data = fillUrl
          ? await downloadImageAsPng(fillUrl, input.fetchImpl ?? fetch, input.signal)
          : await downloadPng(url!, input.fetchImpl ?? fetch, input.signal);
        total += data.byteLength;
        if (total > MAX_BATCH_BYTES) throw new DesignToHarmonyError("SOURCE_RESPONSE_TOO_LARGE", "Rendered design assets exceed the preview limit", { status: 413, stage: "source" });
        writePrivateBufferAtomic(join(cacheRoot, `${cacheKey(input.source, input.sourceVersion, nodeId)}.png`), data);
        assets.push({ sourceNodeId: nodeId, mediaType: "image/png", data });
      } catch (error) {
        if (input.signal?.aborted) throw error;
        fallbackReasons.set(nodeId, error instanceof Error ? error.message : "Design asset download failed");
      }
    }
  }
  return { assets: assets.sort((a, b) => a.sourceNodeId.localeCompare(b.sourceNodeId)), fallbackReasons, cacheHits };
}

export async function exportDesignReferences(input: {
  adapter: DesignSourceAdapter;
  source: DesignSourceRef;
  sourceVersion: string;
  nodeIds: string[];
  outputRoot: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<DesignReferenceExport[]> {
  const nodeIds = [...new Set(input.nodeIds)].sort();
  if (!nodeIds.length) return [];
  let renders;
  try {
    renders = await input.adapter.renderReference(input.source, nodeIds, input.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Design reference render failed";
    return nodeIds.map((nodeId) => ({ nodeId, error: message }));
  }
  const byNode = new Map(renders.map((render) => [render.nodeId, render.url]));
  const result: DesignReferenceExport[] = [];
  mkdirSync(input.outputRoot, { recursive: true, mode: 0o700 });
  for (const nodeId of nodeIds) {
    const url = byNode.get(nodeId);
    if (!url) {
      result.push({ nodeId, error: "The design source did not return a reference render for this node" });
      continue;
    }
    try {
      const data = await downloadPng(url, input.fetchImpl ?? fetch, input.signal);
      const name = `${cacheKey(input.source, input.sourceVersion, nodeId).slice(0, 24)}.png`;
      const path = join(resolve(input.outputRoot), name);
      writePrivateBufferAtomic(path, data);
      result.push({ nodeId, path, data });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      result.push({ nodeId, error: error instanceof Error ? error.message : "Design reference download failed" });
    }
  }
  return result;
}
