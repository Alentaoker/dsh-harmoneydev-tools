import { inflateSync } from "node:zlib";

import type { HarmonyScreenshot } from "./types";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DECODED_BYTES = 96 * 1024 * 1024;
const DEFAULT_MAX_SAMPLES = 24_000;

export interface HarmonyScreenshotRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface HarmonyScreenshotSample {
  width: number;
  height: number;
  region: HarmonyScreenshotRegion;
  stride: number;
  rgb: Buffer;
}

export interface HarmonyScreenshotDifference {
  changedRatio: number;
  meanDelta: number;
  sampledPixels: number;
}

interface ParsedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  palette?: Buffer;
  data: Buffer;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function parsePng(data: Buffer): ParsedPng {
  if (data.length < 33 || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Screen stability requires a valid PNG screenshot.");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let palette: Buffer | undefined;
  const compressed: Buffer[] = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > data.length) throw new Error("Screen stability received a truncated PNG screenshot.");
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (length !== 13) throw new Error("Screen stability received an invalid PNG header.");
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(chunk);
    } else if (type === "IDAT") {
      compressed.push(Buffer.from(chunk));
    } else if (type === "IEND") {
      break;
    }
    offset = chunkEnd;
  }

  if (!width || !height || compressed.length === 0) {
    throw new Error("Screen stability received an incomplete PNG screenshot.");
  }
  if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(colorType)) {
    throw new Error(`Screen stability does not support PNG bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace}.`);
  }
  if (colorType === 3 && (!palette || palette.length < 3)) {
    throw new Error("Screen stability received an indexed PNG without a palette.");
  }
  return { width, height, bitDepth, colorType, interlace, palette, data: Buffer.concat(compressed) };
}

function channelsForColorType(colorType: number): number {
  return { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 0;
}

function decodeScanlines(png: ParsedPng): { pixels: Buffer; channels: number } {
  const channels = channelsForColorType(png.colorType);
  const rowBytes = png.width * channels;
  const expectedBytes = (rowBytes + 1) * png.height;
  if (expectedBytes <= 0 || expectedBytes > MAX_DECODED_BYTES) {
    throw new Error("Screen stability screenshot exceeds the decoded pixel limit.");
  }
  const filtered = inflateSync(png.data, { maxOutputLength: expectedBytes });
  if (filtered.length !== expectedBytes) {
    throw new Error("Screen stability received PNG scanlines with an unexpected size.");
  }

  const pixels = Buffer.allocUnsafe(rowBytes * png.height);
  for (let y = 0; y < png.height; y += 1) {
    const sourceOffset = y * (rowBytes + 1);
    const targetOffset = y * rowBytes;
    const filter = filtered[sourceOffset];
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = filtered[sourceOffset + 1 + x];
      const left = x >= channels ? pixels[targetOffset + x - channels] : 0;
      const above = y > 0 ? pixels[targetOffset - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[targetOffset - rowBytes + x - channels] : 0;
      let value: number;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + above; break;
        case 3: value = raw + Math.floor((left + above) / 2); break;
        case 4: value = raw + paeth(left, above, upperLeft); break;
        default: throw new Error(`Screen stability received unsupported PNG filter ${filter}.`);
      }
      pixels[targetOffset + x] = value & 0xff;
    }
  }
  return { pixels, channels };
}

function validateRegion(
  width: number,
  height: number,
  region: HarmonyScreenshotRegion | undefined,
): HarmonyScreenshotRegion {
  const resolved = region ?? { left: 0, top: 0, right: width, bottom: height };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value)) throw new Error(`Screen stability region ${name} must be an integer.`);
  }
  if (
    resolved.left < 0 || resolved.top < 0 || resolved.right > width || resolved.bottom > height
    || resolved.left >= resolved.right || resolved.top >= resolved.bottom
  ) {
    throw new Error(`Screen stability region must fit inside the ${width}x${height} screenshot.`);
  }
  return resolved;
}

function rgbAt(
  png: ParsedPng,
  pixels: Buffer,
  channels: number,
  x: number,
  y: number,
): readonly [number, number, number] {
  const offset = (y * png.width + x) * channels;
  if (png.colorType === 0 || png.colorType === 4) {
    return [pixels[offset], pixels[offset], pixels[offset]];
  }
  if (png.colorType === 3) {
    const paletteOffset = pixels[offset] * 3;
    return [png.palette![paletteOffset] ?? 0, png.palette![paletteOffset + 1] ?? 0, png.palette![paletteOffset + 2] ?? 0];
  }
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
}

export function sampleHarmonyScreenshot(
  screenshot: HarmonyScreenshot,
  options: { region?: HarmonyScreenshotRegion; maxSamples?: number } = {},
): HarmonyScreenshotSample {
  const png = parsePng(screenshot.data);
  const region = validateRegion(png.width, png.height, options.region);
  const area = (region.right - region.left) * (region.bottom - region.top);
  const maximum = Math.max(100, Math.min(100_000, Math.round(options.maxSamples ?? DEFAULT_MAX_SAMPLES)));
  const stride = Math.max(1, Math.ceil(Math.sqrt(area / maximum)));
  const { pixels, channels } = decodeScanlines(png);
  const rgb: number[] = [];
  for (let y = region.top; y < region.bottom; y += stride) {
    for (let x = region.left; x < region.right; x += stride) rgb.push(...rgbAt(png, pixels, channels, x, y));
  }
  return { width: png.width, height: png.height, region, stride, rgb: Buffer.from(rgb) };
}

export function compareHarmonyScreenshotSamples(
  previous: HarmonyScreenshotSample,
  current: HarmonyScreenshotSample,
  pixelThreshold = 16,
): HarmonyScreenshotDifference {
  if (
    previous.width !== current.width || previous.height !== current.height
    || previous.stride !== current.stride
    || JSON.stringify(previous.region) !== JSON.stringify(current.region)
    || previous.rgb.length !== current.rgb.length
  ) {
    return { changedRatio: 1, meanDelta: 255, sampledPixels: 0 };
  }
  if (!Number.isFinite(pixelThreshold) || pixelThreshold < 0 || pixelThreshold > 255) {
    throw new Error("Screen stability pixelThreshold must be between 0 and 255.");
  }
  const sampledPixels = previous.rgb.length / 3;
  let changedPixels = 0;
  let totalDelta = 0;
  for (let offset = 0; offset < previous.rgb.length; offset += 3) {
    const delta = (
      Math.abs(previous.rgb[offset] - current.rgb[offset])
      + Math.abs(previous.rgb[offset + 1] - current.rgb[offset + 1])
      + Math.abs(previous.rgb[offset + 2] - current.rgb[offset + 2])
    ) / 3;
    totalDelta += delta;
    if (delta > pixelThreshold) changedPixels += 1;
  }
  return {
    changedRatio: sampledPixels === 0 ? 1 : changedPixels / sampledPixels,
    meanDelta: sampledPixels === 0 ? 255 : totalDelta / sampledPixels,
    sampledPixels,
  };
}
