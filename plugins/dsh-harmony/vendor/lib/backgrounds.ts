import manifestJson from "../public/themes/dream-backgrounds/manifest.json";

export type BackgroundAppearance = "light" | "dark";
export type BackgroundArtworkStatus = "planned" | "available";

export interface BackgroundPreset {
  id: string;
  nameKey: string;
  asset: string;
  artworkStatus: BackgroundArtworkStatus;
  appearance: BackgroundAppearance;
  fallback: string;
}

export interface BackgroundManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  artworkStatus: "pending-generation" | "complete";
  assetRoot: string;
  security: {
    remoteUrls: false;
    scripts: false;
    html: false;
    runtimeStyleInjection: false;
  };
  presets: readonly BackgroundPreset[];
}

export const BACKGROUND_PREFERENCE_STORAGE_KEY = "pi-background:v1";
export const CUSTOM_BACKGROUND_FALLBACK_STORAGE_KEY = "pi-background:custom-data-url:v1";
export const CUSTOM_BACKGROUND_MAX_BYTES = 12 * 1024 * 1024;
export const CUSTOM_BACKGROUND_DATA_URL_FALLBACK_MAX_BYTES = 1536 * 1024;
export const CUSTOM_BACKGROUND_MAX_PIXELS = 48_000_000;
export const CUSTOM_BACKGROUND_MAX_DIMENSION = 12_000;
export const CUSTOM_BACKGROUND_RENDER_MAX_PIXELS = 12_000_000;
export const CUSTOM_BACKGROUND_RENDER_MAX_DIMENSION = 4_096;

export function fitCustomBackgroundForRendering(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(
    1,
    CUSTOM_BACKGROUND_RENDER_MAX_DIMENSION / width,
    CUSTOM_BACKGROUND_RENDER_MAX_DIMENSION / height,
    Math.sqrt(CUSTOM_BACKGROUND_RENDER_MAX_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type SupportedBackgroundMime =
  | "image/avif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export const SUPPORTED_BACKGROUND_MIME_TYPES: readonly SupportedBackgroundMime[] = [
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type BackgroundSource = "none" | "builtin" | "custom";

export interface BackgroundPreference {
  schemaVersion: 1;
  source: BackgroundSource;
  presetId: string | null;
  overlay: number;
  blur: number;
  sidebarOverlay: number;
  filePanelOverlay: number;
}

export const DEFAULT_BACKGROUND_PREFERENCE: Readonly<BackgroundPreference> = Object.freeze({
  schemaVersion: 1,
  source: "none",
  presetId: null,
  overlay: 58,
  blur: 0,
  sidebarOverlay: 36,
  filePanelOverlay: 42,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeAssetPath(value: unknown, assetRoot: string): value is string {
  return typeof value === "string"
    && value.startsWith(assetRoot)
    && !value.includes("://")
    && !value.includes("\\")
    && !value.includes("..")
    && value.endsWith(".webp");
}

function isSafeFallback(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1200) return false;
  const normalized = value.toLowerCase();
  return !normalized.includes("url(")
    && !normalized.includes("javascript:")
    && !normalized.includes("expression(")
    && !normalized.includes("@import");
}

/** Validates the bundled JSON before any path or CSS fallback reaches the DOM. */
export function parseBackgroundManifest(value: unknown): BackgroundManifest {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.description !== "string"
    || (value.artworkStatus !== "pending-generation" && value.artworkStatus !== "complete")
    || typeof value.assetRoot !== "string"
    || !value.assetRoot.startsWith("/themes/dream-backgrounds/")
    || !Array.isArray(value.presets)
    || !isRecord(value.security)
    || value.security.remoteUrls !== false
    || value.security.scripts !== false
    || value.security.html !== false
    || value.security.runtimeStyleInjection !== false) {
    throw new Error("Invalid bundled background manifest");
  }

  const seen = new Set<string>();
  const presets = value.presets.map((candidate): BackgroundPreset => {
    if (!isRecord(candidate)
      || typeof candidate.id !== "string"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.id)
      || seen.has(candidate.id)
      || typeof candidate.nameKey !== "string"
      || !candidate.nameKey.startsWith("background.preset.")
      || !isSafeAssetPath(candidate.asset, value.assetRoot as string)
      || (candidate.artworkStatus !== "planned" && candidate.artworkStatus !== "available")
      || (candidate.appearance !== "light" && candidate.appearance !== "dark")
      || !isSafeFallback(candidate.fallback)) {
      throw new Error("Invalid bundled background preset");
    }
    seen.add(candidate.id);
    return {
      id: candidate.id,
      nameKey: candidate.nameKey,
      asset: candidate.asset,
      artworkStatus: candidate.artworkStatus,
      appearance: candidate.appearance,
      fallback: candidate.fallback,
    };
  });

  return Object.freeze({
    schemaVersion: 1,
    id: value.id,
    name: value.name,
    description: value.description,
    artworkStatus: value.artworkStatus,
    assetRoot: value.assetRoot,
    security: Object.freeze({
      remoteUrls: false,
      scripts: false,
      html: false,
      runtimeStyleInjection: false,
    }),
    presets: Object.freeze(presets),
  });
}

export const BACKGROUND_MANIFEST = parseBackgroundManifest(manifestJson);
export const BACKGROUND_PRESETS = BACKGROUND_MANIFEST.presets;

const BACKGROUND_PREPAINT_PRESETS = JSON.stringify(Object.fromEntries(
  BACKGROUND_PRESETS.map((preset) => [preset.id, {
    asset: preset.artworkStatus === "available" ? preset.asset : null,
    fallback: preset.fallback,
  }]),
)).replace(/</g, "\\u003c");

/** Restores a validated built-in background before React/IndexedDB hydration. */
export const BACKGROUND_INITIALIZATION_SCRIPT = `(function(){try{var p=${BACKGROUND_PREPAINT_PRESETS},v=localStorage.getItem("${BACKGROUND_PREFERENCE_STORAGE_KEY}");if(!v)return;var s=JSON.parse(v),b=s&&s.source==="builtin"&&typeof s.presetId==="string"?p[s.presetId]:null;if(!b)return;var n=function(x,d,a,z){return typeof x==="number"&&isFinite(x)?Math.min(z,Math.max(a,Math.round(x))):d},o=n(s.overlay,58,0,90),l=n(s.blur,0,0,24),u=n(s.sidebarOverlay,36,0,90),f=n(s.filePanelOverlay,42,0,90),r=document.documentElement;r.dataset.appBackgroundActive="true";r.dataset.appBackgroundSource="builtin";r.dataset.appBackgroundPreset=s.presetId;r.style.setProperty("--app-background-image",b.asset?'url("'+b.asset+'")':"none");r.style.setProperty("--app-background-fallback",b.fallback);r.style.setProperty("--app-background-overlay",o+"%");r.style.setProperty("--app-background-blur",l+"px");r.style.setProperty("--app-background-sidebar-overlay",u+"%");r.style.setProperty("--app-background-file-panel-overlay",f+"%")}catch(_){}})();`;

const PRESETS_BY_ID = new Map(BACKGROUND_PRESETS.map((preset) => [preset.id, preset]));

export function getBackgroundPreset(id: string | null | undefined): BackgroundPreset | undefined {
  return id ? PRESETS_BY_ID.get(id) : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeBackgroundPreference(value: unknown): BackgroundPreference {
  if (!isRecord(value)) return { ...DEFAULT_BACKGROUND_PREFERENCE };

  const overlay = clampInteger(value.overlay, DEFAULT_BACKGROUND_PREFERENCE.overlay, 0, 90);
  const blur = clampInteger(value.blur, DEFAULT_BACKGROUND_PREFERENCE.blur, 0, 24);
  const sidebarOverlay = clampInteger(value.sidebarOverlay, DEFAULT_BACKGROUND_PREFERENCE.sidebarOverlay, 0, 90);
  const filePanelOverlay = clampInteger(value.filePanelOverlay, DEFAULT_BACKGROUND_PREFERENCE.filePanelOverlay, 0, 90);

  if (value.source === "builtin" && typeof value.presetId === "string" && getBackgroundPreset(value.presetId)) {
    return { schemaVersion: 1, source: "builtin", presetId: value.presetId, overlay, blur, sidebarOverlay, filePanelOverlay };
  }
  if (value.source === "custom") {
    return { schemaVersion: 1, source: "custom", presetId: null, overlay, blur, sidebarOverlay, filePanelOverlay };
  }
  return { schemaVersion: 1, source: "none", presetId: null, overlay, blur, sidebarOverlay, filePanelOverlay };
}

export function parseStoredBackgroundPreference(value: string | null): BackgroundPreference {
  if (!value) return { ...DEFAULT_BACKGROUND_PREFERENCE };
  try {
    return normalizeBackgroundPreference(JSON.parse(value) as unknown);
  } catch {
    return { ...DEFAULT_BACKGROUND_PREFERENCE };
  }
}

export function serializeBackgroundPreference(preference: BackgroundPreference): string {
  return JSON.stringify(normalizeBackgroundPreference(preference));
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

/** Detects supported raster formats from magic bytes; SVG and arbitrary data are rejected. */
export function detectBackgroundImageMime(bytes: Uint8Array): SupportedBackgroundMime | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 16 && ascii(bytes, 4, 4) === "ftyp") {
    const brands = ascii(bytes, 8, Math.min(bytes.length - 8, 24));
    if (brands.includes("avif") || brands.includes("avis")) return "image/avif";
  }
  return null;
}

export function isSafeCustomBackgroundDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > CUSTOM_BACKGROUND_DATA_URL_FALLBACK_MAX_BYTES * 2) {
    return false;
  }
  return /^data:image\/(?:avif|jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(value);
}
