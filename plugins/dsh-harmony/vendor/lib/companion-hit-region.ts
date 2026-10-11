export interface NormalizedCompanionHitRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

const FULL_REGION: NormalizedCompanionHitRegion = {
  left: 0,
  top: 0,
  width: 1,
  height: 1,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function findCompanionAlphaHitRegion(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  alphaThreshold = 24,
): NormalizedCompanionHitRegion | null {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) return null;
  if (rgba.length < width * height * 4) return null;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] < alphaThreshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return {
    left: minX / width,
    top: minY / height,
    width: (maxX - minX + 1) / width,
    height: (maxY - minY + 1) / height,
  };
}

export function padCompanionHitRegion(
  input: NormalizedCompanionHitRegion | null,
  padding = 0.025,
  minimumWidth = 0.2,
  minimumHeight = 0.16,
): NormalizedCompanionHitRegion {
  const region = input ?? FULL_REGION;
  const paddedLeft = clamp(region.left - padding, 0, 1);
  const paddedTop = clamp(region.top - padding, 0, 1);
  const paddedRight = clamp(region.left + region.width + padding, 0, 1);
  const paddedBottom = clamp(region.top + region.height + padding, 0, 1);
  const centerX = (paddedLeft + paddedRight) / 2;
  const centerY = (paddedTop + paddedBottom) / 2;
  const width = clamp(Math.max(paddedRight - paddedLeft, minimumWidth), 0, 1);
  const height = clamp(Math.max(paddedBottom - paddedTop, minimumHeight), 0, 1);
  return {
    left: clamp(centerX - width / 2, 0, 1 - width),
    top: clamp(centerY - height / 2, 0, 1 - height),
    width,
    height,
  };
}

export function fitCompanionHitRegion(
  input: NormalizedCompanionHitRegion,
  sourceWidth: number,
  sourceHeight: number,
  viewportRatio = 192 / 208,
): NormalizedCompanionHitRegion {
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(viewportRatio > 0)) return { ...FULL_REGION };
  const sourceRatio = sourceWidth / sourceHeight;
  const fittedWidth = sourceRatio >= viewportRatio ? 1 : sourceRatio / viewportRatio;
  const fittedHeight = sourceRatio >= viewportRatio ? viewportRatio / sourceRatio : 1;
  const offsetX = (1 - fittedWidth) / 2;
  const offsetY = (1 - fittedHeight) / 2;
  return {
    left: offsetX + clamp(input.left, 0, 1) * fittedWidth,
    top: offsetY + clamp(input.top, 0, 1) * fittedHeight,
    width: clamp(input.width, 0, 1) * fittedWidth,
    height: clamp(input.height, 0, 1) * fittedHeight,
  };
}
