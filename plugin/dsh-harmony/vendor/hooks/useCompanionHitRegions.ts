"use client";

import { useEffect, useState } from "react";
import {
  findCompanionAlphaHitRegion,
  fitCompanionHitRegion,
  padCompanionHitRegion,
  type NormalizedCompanionHitRegion,
} from "@/lib/companion-hit-region";

interface CompanionHitRegionSource {
  url: string;
  frameWidth?: number;
  frameHeight?: number;
  columns?: number;
  rows?: number;
}

const MAX_SAMPLE_EDGE = 96;
const regionCache = new Map<string, Promise<NormalizedCompanionHitRegion[]>>();

function loadHitRegions(source: CompanionHitRegionSource): Promise<NormalizedCompanionHitRegion[]> {
  const cacheKey = [source.url, source.frameWidth, source.frameHeight, source.columns, source.rows].join(":");
  const cached = regionCache.get(cacheKey);
  if (cached) return cached;

  const pending = new Promise<NormalizedCompanionHitRegion[]>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      const columns = Math.max(1, Math.floor(source.columns ?? 1));
      const rows = Math.max(1, Math.floor(source.rows ?? 1));
      const frameWidth = source.frameWidth ?? image.naturalWidth / columns;
      const frameHeight = source.frameHeight ?? image.naturalHeight / rows;
      if (!(frameWidth > 0) || !(frameHeight > 0)) {
        reject(new Error("Invalid companion sprite dimensions"));
        return;
      }
      const sampleScale = Math.min(1, MAX_SAMPLE_EDGE / Math.max(frameWidth, frameHeight));
      const sampleWidth = Math.max(1, Math.round(frameWidth * sampleScale));
      const sampleHeight = Math.max(1, Math.round(frameHeight * sampleScale));
      const canvas = document.createElement("canvas");
      canvas.width = sampleWidth * columns;
      canvas.height = sampleHeight * rows;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        reject(new Error("Companion sprite inspection is unavailable"));
        return;
      }
      const regions: NormalizedCompanionHitRegion[] = [];
      try {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        for (let index = 0; index < columns * rows; index += 1) {
          const sampleX = (index % columns) * sampleWidth;
          const sampleY = Math.floor(index / columns) * sampleHeight;
          const pixels = context.getImageData(sampleX, sampleY, sampleWidth, sampleHeight).data;
          const visibleRegion = padCompanionHitRegion(
            findCompanionAlphaHitRegion(pixels, sampleWidth, sampleHeight),
          );
          regions.push(fitCompanionHitRegion(visibleRegion, frameWidth, frameHeight));
        }
        resolve(regions);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error("Companion sprite could not be inspected"));
    image.src = source.url;
  });
  regionCache.set(cacheKey, pending);
  void pending.catch(() => regionCache.delete(cacheKey));
  return pending;
}

export function useCompanionHitRegions(
  source: CompanionHitRegionSource,
): NormalizedCompanionHitRegion[] | null {
  const [regions, setRegions] = useState<NormalizedCompanionHitRegion[] | null>(null);
  const { url, frameWidth, frameHeight, columns, rows } = source;

  useEffect(() => {
    let cancelled = false;
    setRegions(null);
    void loadHitRegions({ url, frameWidth, frameHeight, columns, rows })
      .then((next) => { if (!cancelled) setRegions(next); })
      .catch(() => { if (!cancelled) setRegions(null); });
    return () => { cancelled = true; };
  }, [columns, frameHeight, frameWidth, rows, url]);

  return regions;
}
