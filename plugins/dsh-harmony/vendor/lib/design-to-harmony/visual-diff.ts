import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import type { HarmonyUiNode } from "../harmony/types";
import type { DesignVisualComparison, DesignVisualDiffRegion } from "./types";

const MAX_COMPARE_WIDTH = 1440;
const MAX_COMPARE_HEIGHT = 2560;
const BLOCK_SIZE = 12;

type RawImage = { data: Buffer; width: number; height: number };
type VerticalCrop = { top: number; bottom: number };

async function normalizeImage(data: Buffer, width: number, height: number, sourceWidth: number, sourceHeight: number, crop: VerticalCrop = { top: 0, bottom: 0 }): Promise<RawImage> {
  const top = Math.max(0, Math.min(sourceHeight - 1, Math.round(crop.top)));
  const bottom = Math.max(0, Math.min(sourceHeight - top - 1, Math.round(crop.bottom)));
  let pipeline = sharp(data, { limitInputPixels: 32_000_000 });
  if (top || bottom) pipeline = pipeline.extract({ left: 0, top, width: sourceWidth, height: sourceHeight - top - bottom });
  const output = await pipeline
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: output.data, width: output.info.width, height: output.info.height };
}

function inferActualCrop(input: {
  referenceWidth: number;
  referenceHeight: number;
  actualWidth: number;
  actualHeight: number;
  safeArea?: VerticalCrop;
}): VerticalCrop {
  if (input.safeArea) {
    const top = Math.max(0, Math.min(input.actualHeight - 1, Math.round(input.safeArea.top)));
    const bottom = Math.max(0, Math.min(input.actualHeight - top - 1, Math.round(input.safeArea.bottom)));
    return { top, bottom };
  }
  const expectedContentHeight = input.actualWidth * input.referenceHeight / input.referenceWidth;
  const excess = input.actualHeight - expectedContentHeight;
  if (excess <= 1 || excess > input.actualHeight * 0.2) return { top: 0, bottom: 0 };
  const top = Math.floor(excess / 2);
  return { top, bottom: Math.ceil(excess - top) };
}

function overlap(left: { left: number; top: number; right: number; bottom: number }, right: { left: number; top: number; right: number; bottom: number }): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function regionsFromGrid(input: {
  changed: Uint8Array;
  width: number;
  height: number;
  changedPixels: number;
  nodes: HarmonyUiNode[];
  actualWidth: number;
  actualHeight: number;
  actualCropTop: number;
  sourceNodeIds: string[];
}): DesignVisualDiffRegion[] {
  const columns = Math.ceil(input.width / BLOCK_SIZE);
  const rows = Math.ceil(input.height / BLOCK_SIZE);
  const blockCounts = new Uint32Array(columns * rows);
  for (let y = 0; y < input.height; y += 1) {
    for (let x = 0; x < input.width; x += 1) {
      if (input.changed[y * input.width + x]) blockCounts[Math.floor(y / BLOCK_SIZE) * columns + Math.floor(x / BLOCK_SIZE)] += 1;
    }
  }
  const visited = new Uint8Array(blockCounts.length);
  const regions: DesignVisualDiffRegion[] = [];
  for (let index = 0; index < blockCounts.length; index += 1) {
    if (visited[index] || blockCounts[index] === 0) continue;
    const queue = [index];
    visited[index] = 1;
    let minX = columns;
    let minY = rows;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    for (let offset = 0; offset < queue.length; offset += 1) {
      const current = queue[offset];
      const y = Math.floor(current / columns);
      const x = current % columns;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      count += blockCounts[current];
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        const next = ny * columns + nx;
        if (!visited[next] && blockCounts[next] > 0) { visited[next] = 1; queue.push(next); }
      }
    }
    const bounds = {
      left: minX * BLOCK_SIZE,
      top: minY * BLOCK_SIZE,
      right: Math.min(input.width, (maxX + 1) * BLOCK_SIZE),
      bottom: Math.min(input.height, (maxY + 1) * BLOCK_SIZE),
    };
    const nodeRefs = input.nodes.flatMap((node) => {
      if (!node.bounds || input.actualWidth <= 0 || input.actualHeight <= 0) return [];
      const scaled = {
        left: node.bounds.left * input.width / input.actualWidth,
        top: (node.bounds.top - input.actualCropTop) * input.height / input.actualHeight,
        right: node.bounds.right * input.width / input.actualWidth,
        bottom: (node.bounds.bottom - input.actualCropTop) * input.height / input.actualHeight,
      };
      return overlap(bounds, scaled) ? [node.ref] : [];
    }).slice(0, 20);
    regions.push({
      ...bounds,
      changedPixels: count,
      ratio: input.changedPixels ? count / input.changedPixels : 0,
      uiNodeRefs: nodeRefs,
      sourceNodeIds: input.sourceNodeIds,
    });
  }
  return regions.sort((a, b) => b.changedPixels - a.changedPixels).slice(0, 50);
}

export async function compareDesignScreenshots(input: {
  reference: Buffer;
  actual: Buffer;
  outputPath: string;
  nodes?: HarmonyUiNode[];
  sourceNodeIds?: string[];
  threshold?: number;
  allowedChangedRatio?: number;
  safeArea?: { top?: number; bottom?: number };
  alignedReferencePath?: string;
  alignedActualPath?: string;
}): Promise<DesignVisualComparison> {
  const referenceMeta = await sharp(input.reference, { limitInputPixels: 32_000_000 }).metadata();
  const actualMeta = await sharp(input.actual, { limitInputPixels: 32_000_000 }).metadata();
  if (!referenceMeta.width || !referenceMeta.height || !actualMeta.width || !actualMeta.height) {
    return { status: "unavailable", threshold: input.threshold ?? 24, regions: [], message: "Reference or device screenshot dimensions are unavailable." };
  }
  const scale = Math.min(1, MAX_COMPARE_WIDTH / referenceMeta.width, MAX_COMPARE_HEIGHT / referenceMeta.height);
  const width = Math.max(1, Math.round(referenceMeta.width * scale));
  const height = Math.max(1, Math.round(referenceMeta.height * scale));
  const actualCrop = inferActualCrop({
    referenceWidth: referenceMeta.width,
    referenceHeight: referenceMeta.height,
    actualWidth: actualMeta.width,
    actualHeight: actualMeta.height,
    ...(input.safeArea ? { safeArea: { top: input.safeArea.top ?? 0, bottom: input.safeArea.bottom ?? 0 } } : {}),
  });
  const actualContentHeight = actualMeta.height - actualCrop.top - actualCrop.bottom;
  const [reference, actual] = await Promise.all([
    normalizeImage(input.reference, width, height, referenceMeta.width, referenceMeta.height),
    normalizeImage(input.actual, width, height, actualMeta.width, actualMeta.height, actualCrop),
  ]);
  const pixelThreshold = Math.max(0, Math.min(255, Math.round(input.threshold ?? 24)));
  const changed = new Uint8Array(width * height);
  const diff = Buffer.alloc(width * height * 4);
  let changedPixels = 0;
  let comparedPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const source = pixel * 3;
      const target = pixel * 4;
      const delta = Math.max(
        Math.abs(reference.data[source] - actual.data[source]),
        Math.abs(reference.data[source + 1] - actual.data[source + 1]),
        Math.abs(reference.data[source + 2] - actual.data[source + 2]),
      );
      const isChanged = delta > pixelThreshold;
      comparedPixels += 1;
      if (isChanged) { changed[pixel] = 1; changedPixels += 1; }
      if (isChanged) {
        diff[target] = 239; diff[target + 1] = 68; diff[target + 2] = 68; diff[target + 3] = 230;
      } else {
        const gray = Math.round((actual.data[source] + actual.data[source + 1] + actual.data[source + 2]) / 3);
        diff[target] = gray; diff[target + 1] = gray; diff[target + 2] = gray; diff[target + 3] = 120;
      }
    }
  }
  const changedRatio = comparedPixels ? changedPixels / comparedPixels : 1;
  const outputPath = resolve(input.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const [encoded, encodedReference, encodedActual] = await Promise.all([
    sharp(diff, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer(),
    input.alignedReferencePath ? sharp(reference.data, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer() : undefined,
    input.alignedActualPath ? sharp(actual.data, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer() : undefined,
  ]);
  writeFileSync(outputPath, encoded, { mode: 0o600 });
  let referencePath: string | undefined;
  let actualPath: string | undefined;
  if (input.alignedReferencePath && encodedReference) {
    referencePath = resolve(input.alignedReferencePath);
    mkdirSync(dirname(referencePath), { recursive: true, mode: 0o700 });
    writeFileSync(referencePath, encodedReference, { mode: 0o600 });
  }
  if (input.alignedActualPath && encodedActual) {
    actualPath = resolve(input.alignedActualPath);
    mkdirSync(dirname(actualPath), { recursive: true, mode: 0o700 });
    writeFileSync(actualPath, encodedActual, { mode: 0o600 });
  }
  return {
    status: changedRatio <= (input.allowedChangedRatio ?? 0.015) ? "passed" : "different",
    diffPath: outputPath,
    width,
    height,
    changedPixels,
    changedRatio,
    threshold: pixelThreshold,
    ...(referencePath ? { referencePath } : {}),
    ...(actualPath ? { actualPath } : {}),
    regions: regionsFromGrid({
      changed,
      width,
      height,
      changedPixels,
      nodes: input.nodes ?? [],
      actualWidth: actualMeta.width,
      actualHeight: actualContentHeight,
      actualCropTop: actualCrop.top,
      sourceNodeIds: input.sourceNodeIds ?? [],
    }),
  };
}
