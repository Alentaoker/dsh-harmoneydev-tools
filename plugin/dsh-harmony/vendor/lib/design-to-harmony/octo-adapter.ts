import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { designToHarmonyDataRoot } from "./data-root";
import { DesignToHarmonyError } from "./errors";
import { normalizeFigmaDocumentSummary, normalizeFigmaVariables } from "./figma-adapter";
import type { DesignSourceAdapter } from "./source-adapter";
import type {
  DesignAssetRequest,
  DesignAssetResult,
  DesignDocumentSummary,
  DesignReferenceRender,
  DesignSourceNodePayload,
  DesignSourceRef,
  DesignSourceVersion,
  DesignVariableCatalog,
} from "./types";

const MAX_OCTO_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_OCTO_NODES = 20_000;
const MAX_OCTO_DEPTH = 128;

interface StoredOctoSource {
  schemaVersion: 1;
  fileKey: string;
  originalFileName: string;
  importedAt: string;
  version: DesignSourceVersion;
  payload: Record<string, unknown>;
}

interface NormalizedOctoPayload {
  document: Record<string, unknown>;
  name: string;
  components: Record<string, Record<string, unknown>>;
  componentSets: Record<string, Record<string, unknown>>;
  styles: Record<string, Record<string, unknown>>;
  variables: DesignVariableCatalog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeOriginalFileName(value: string): string {
  const name = basename(value.trim() || "octo-design.json").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 180);
  return name || "octo-design.json";
}

function parseCssColor(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) {
    const rgb = hex[1];
    return {
      r: Number.parseInt(rgb.slice(0, 2), 16) / 255,
      g: Number.parseInt(rgb.slice(2, 4), 16) / 255,
      b: Number.parseInt(rgb.slice(4, 6), 16) / 255,
      a: hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1,
    };
  }
  const rgba = value.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!rgba) return undefined;
  return {
    r: Math.max(0, Math.min(255, Number(rgba[1]))) / 255,
    g: Math.max(0, Math.min(255, Number(rgba[2]))) / 255,
    b: Math.max(0, Math.min(255, Number(rgba[3]))) / 255,
    a: rgba[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(rgba[4]))),
  };
}

function textRun(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(value.textData) || !Array.isArray(value.textData.text)) return undefined;
  return value.textData.text.find(isRecord);
}

function normalizedTextStyle(value: Record<string, unknown>): Record<string, unknown> {
  const raw = isRecord(value.style) ? value.style : {};
  const run = textRun(value) ?? {};
  const cssFontSize = optionalString(raw["font-size"]);
  const cssLineHeight = optionalString(raw["line-height"]);
  const fontSize = optionalNumber(raw.fontSize) ?? optionalNumber(run.fontSize) ?? (cssFontSize ? Number.parseFloat(cssFontSize) : undefined);
  const lineHeightPx = optionalNumber(raw.lineHeightPx) ?? optionalNumber(run.lineHeightPx) ?? (cssLineHeight ? Number.parseFloat(cssLineHeight) : undefined);
  const letterSpacing = optionalNumber(raw.letterSpacing) ?? optionalNumber(run.letterSpacing);
  return {
    ...raw,
    ...(optionalString(raw.fontFamily) ?? optionalString(run.fontFamily) ? { fontFamily: optionalString(raw.fontFamily) ?? optionalString(run.fontFamily) } : {}),
    ...(optionalNumber(raw.fontWeight) ?? optionalNumber(run.fontWeight) ? { fontWeight: optionalNumber(raw.fontWeight) ?? optionalNumber(run.fontWeight) } : {}),
    ...(Number.isFinite(fontSize) ? { fontSize } : {}),
    ...(Number.isFinite(lineHeightPx) ? { lineHeightPx } : {}),
    ...(letterSpacing !== undefined ? { letterSpacing } : {}),
    ...(optionalString(raw.textAlignHorizontal) ?? optionalString(run.textAlignHorizontal) ? { textAlignHorizontal: optionalString(raw.textAlignHorizontal) ?? optionalString(run.textAlignHorizontal) } : {}),
  };
}

function normalizeOctoNode(value: unknown, state: { count: number; ids: Set<string> }, depth = 0): Record<string, unknown> {
  if (!isRecord(value) || depth > MAX_OCTO_DEPTH) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Octo JSON contains an invalid or excessively deep node tree", { status: 422, stage: "import" });
  }
  state.count += 1;
  if (state.count > MAX_OCTO_NODES) {
    throw new DesignToHarmonyError("SOURCE_RESPONSE_TOO_LARGE", `Octo JSON contains more than ${MAX_OCTO_NODES} nodes`, { status: 413, stage: "import" });
  }
  const id = optionalString(value.id);
  if (!id || id.length > 256 || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Every Octo design node must have a valid id", { status: 422, stage: "import" });
  }
  if (state.ids.has(id)) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", `Octo JSON contains the duplicate node id ${id}`, { status: 422, stage: "import" });
  }
  state.ids.add(id);

  const rawChildren = Array.isArray(value.children) ? value.children : [];
  const children = rawChildren.map((child) => normalizeOctoNode(child, state, depth + 1));
  const x = optionalNumber(value.x);
  const y = optionalNumber(value.y);
  const width = optionalNumber(value.width);
  const height = optionalNumber(value.height);
  const existingBox = isRecord(value.absoluteBoundingBox) ? value.absoluteBoundingBox : undefined;
  const style = normalizedTextStyle(value);
  const run = textRun(value);
  const characters = optionalString(value.characters) ?? optionalString(run?.characters);
  const existingFills = Array.isArray(value.fills) ? value.fills : [];
  const fallbackColor = parseCssColor(style.color);
  const fills = existingFills.length || !fallbackColor
    ? existingFills
    : [{ type: "SOLID", color: fallbackColor, opacity: fallbackColor.a, visible: true }];

  return {
    ...value,
    id,
    name: optionalString(value.name) ?? id,
    type: (optionalString(value.type) ?? "UNKNOWN").toUpperCase(),
    children,
    layoutMode: (optionalString(value.layoutMode) ?? optionalString(value.originalLayoutMode) ?? "NONE").toUpperCase(),
    ...(existingBox || [x, y, width, height].some((item) => item !== undefined) ? {
      absoluteBoundingBox: {
        ...(existingBox ?? {}),
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      },
    } : {}),
    ...(characters ? { characters } : {}),
    style,
    fills,
  };
}

function nativeColor(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const color = isRecord(value.color) ? value.color : value;
  const channel = (item: unknown) => {
    const number = optionalNumber(item) ?? 0;
    return number > 1 ? Math.max(0, Math.min(255, number)) / 255 : Math.max(0, Math.min(1, number));
  };
  return {
    r: channel(color.red ?? color.r),
    g: channel(color.green ?? color.g),
    b: channel(color.blue ?? color.b),
    a: channel(color.alpha ?? color.a ?? 1),
  };
}

function nativeOctoNode(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > MAX_OCTO_DEPTH) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Octo JSON contains an excessively deep native node tree", { status: 422, stage: "import" });
  }
  const box = isRecord(value.box) ? value.box : {};
  const style = isRecord(value.style) ? value.style : {};
  const type = (optionalString(value.type) ?? "FRAME").toUpperCase();
  const color = nativeColor(type === "TEXT" ? style.font_color : style.background_color);
  const radius = Array.isArray(style.round_corner) ? optionalNumber(style.round_corner[0]) : optionalNumber(style.round_corner);
  const direction = optionalString(style.flex_direction)?.toUpperCase();
  return {
    id: optionalString(value.key) ?? optionalString(value.id) ?? optionalString(value.name) ?? "node",
    name: optionalString(value.name) ?? optionalString(value.key) ?? "Node",
    type,
    x: optionalNumber(box.x) ?? 0,
    y: optionalNumber(box.y) ?? 0,
    width: optionalNumber(box.width) ?? optionalNumber(style.origin_width) ?? 0,
    height: optionalNumber(box.height) ?? optionalNumber(style.origin_height) ?? 0,
    ...(direction === "ROW" ? { layoutMode: "HORIZONTAL" } : direction === "COLUMN" ? { layoutMode: "VERTICAL" } : {}),
    ...(optionalNumber(style.gap) !== undefined ? { itemSpacing: optionalNumber(style.gap) } : {}),
    ...(optionalNumber(style.padding_top) !== undefined ? { paddingTop: optionalNumber(style.padding_top) } : {}),
    ...(optionalNumber(style.padding_right) !== undefined ? { paddingRight: optionalNumber(style.padding_right) } : {}),
    ...(optionalNumber(style.padding_bottom) !== undefined ? { paddingBottom: optionalNumber(style.padding_bottom) } : {}),
    ...(optionalNumber(style.padding_left) !== undefined ? { paddingLeft: optionalNumber(style.padding_left) } : {}),
    ...(optionalNumber(style.opacity) !== undefined ? { opacity: optionalNumber(style.opacity) } : {}),
    ...(radius !== undefined ? { cornerRadius: radius } : {}),
    ...(optionalString(value.content) ? { characters: optionalString(value.content) } : {}),
    style: {
      ...(optionalString(style.font_family) ? { fontFamily: optionalString(style.font_family) } : {}),
      ...(optionalNumber(style.font_weight) !== undefined ? { fontWeight: optionalNumber(style.font_weight) } : {}),
      ...(optionalNumber(style.font_size) !== undefined ? { fontSize: optionalNumber(style.font_size) } : {}),
      ...(optionalNumber(style.line_height) !== undefined ? { lineHeightPx: optionalNumber(style.line_height) } : {}),
      ...(optionalNumber(style.letter_spacing) !== undefined ? { letterSpacing: optionalNumber(style.letter_spacing) } : {}),
      ...(optionalString(style.text_align) ? { textAlignHorizontal: optionalString(style.text_align)?.toUpperCase() } : {}),
    },
    ...(color ? { fills: [{ type: "SOLID", color, opacity: color.a, visible: true }] } : {}),
    children: Array.isArray(value.children) ? value.children.filter(isRecord).map((child) => nativeOctoNode(child, depth + 1)) : [],
  };
}

function sourceRoots(value: Record<string, unknown>, depth = 0): Record<string, unknown>[] {
  if (depth > MAX_OCTO_DEPTH) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Octo JSON contains an excessively deep document wrapper", { status: 422, stage: "import" });
  }
  if (Array.isArray(value.content) && value.content.every(isRecord) && value.content.some((item) => typeof item.key === "string" && isRecord(item.box))) {
    return value.content.map(nativeOctoNode);
  }
  if (isRecord(value.document)) return [value.document];
  if (isRecord(value.data)) return sourceRoots(value.data, depth + 1);
  if (isRecord(value.tree)) return [value.tree];
  if (Array.isArray(value.nodes)) return value.nodes.filter(isRecord);
  if (isRecord(value.nodes)) return Object.values(value.nodes).filter(isRecord).flatMap((item) => sourceRoots(item, depth + 1));
  if (!optionalString(value.type) && Array.isArray(value.children)) return value.children.filter(isRecord);
  return [value];
}

function collectCatalogs(document: Record<string, unknown>): {
  components: Record<string, Record<string, unknown>>;
  componentSets: Record<string, Record<string, unknown>>;
  styles: Record<string, Record<string, unknown>>;
} {
  const components: Record<string, Record<string, unknown>> = {};
  const componentSets: Record<string, Record<string, unknown>> = {};
  const styles: Record<string, Record<string, unknown>> = {};
  const visit = (node: Record<string, unknown>) => {
    const id = String(node.id);
    const summary = { name: optionalString(node.name) ?? id, ...(optionalString(node.description) ? { description: optionalString(node.description) } : {}) };
    if (node.type === "COMPONENT") components[id] = summary;
    if (node.type === "COMPONENT_SET") componentSets[id] = summary;
    if (isRecord(node.styleData)) {
      for (const items of Object.values(node.styleData)) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (!isRecord(item)) continue;
          const styleId = optionalString(item.styleGuid) ?? optionalString(item.id);
          if (styleId) styles[styleId] = {
            name: optionalString(item.name) ?? styleId,
            ...(optionalString(item.type) ? { styleType: optionalString(item.type)?.toUpperCase() } : {}),
            ...(optionalString(item.description) ? { description: optionalString(item.description) } : {}),
          };
        }
      }
    }
    if (Array.isArray(node.children)) for (const child of node.children) if (isRecord(child)) visit(child);
  };
  visit(document);
  return { components, componentSets, styles };
}

function recordCatalog(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])));
}

function normalizeOctoPayload(value: Record<string, unknown>): NormalizedOctoPayload {
  const state = { count: 0, ids: new Set<string>() };
  const roots = sourceRoots(value).map((root) => normalizeOctoNode(root, state));
  if (roots.length === 0) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Octo JSON does not contain any design nodes", { status: 422, stage: "import" });
  }
  const syntheticId = (preferred: string) => {
    let id = preferred;
    let suffix = 2;
    while (state.ids.has(id)) id = `${preferred}_${suffix++}`;
    state.ids.add(id);
    return id;
  };
  let document: Record<string, unknown>;
  const singleRoot = roots.length === 1 ? roots[0] : undefined;
  if (singleRoot?.type === "DOCUMENT") {
    document = singleRoot;
  } else if (roots.every((root) => root.type === "CANVAS")) {
    document = { id: syntheticId("octo_document"), name: optionalString(value.name) ?? "Octo design", type: "DOCUMENT", children: roots };
  } else {
    const page = {
      id: syntheticId("octo_page"),
      name: optionalString(value.pageName) ?? "Page 1",
      type: "CANVAS",
      children: roots,
      flowStartingPoints: roots.map((root, index) => ({ nodeId: root.id, name: optionalString(root.name) ?? `Flow ${index + 1}` })),
    };
    document = { id: syntheticId("octo_document"), name: optionalString(value.name) ?? optionalString(singleRoot?.name) ?? "Octo design", type: "DOCUMENT", children: [page] };
  }
  const discovered = collectCatalogs(document);
  const rawVariables = isRecord(value.variables) && isRecord(value.variables.meta)
    ? value.variables
    : isRecord(value.meta) && (isRecord(value.meta.variableCollections) || isRecord(value.meta.variables))
      ? { meta: value.meta }
      : undefined;
  const variables = rawVariables
    ? normalizeFigmaVariables(rawVariables)
    : { availability: "unavailable" as const, collections: [], variables: [], reason: "This Octo export does not include a variable catalog; literal design values will be preserved." };
  return {
    document,
    name: optionalString(value.name) ?? optionalString(document.name) ?? optionalString(singleRoot?.name) ?? "Octo design",
    components: { ...discovered.components, ...recordCatalog(value.components) },
    componentSets: { ...discovered.componentSets, ...recordCatalog(value.componentSets) },
    styles: { ...discovered.styles, ...recordCatalog(value.styles) },
    variables,
  };
}

function findNode(document: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  if (document.id === id) return document;
  if (!Array.isArray(document.children)) return undefined;
  for (const child of document.children) {
    if (!isRecord(child)) continue;
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

export class OctoSourceStore {
  readonly root: string;

  constructor(root = designToHarmonyDataRoot()) {
    this.root = join(resolve(root), "sources", "octo");
  }

  private path(fileKey: string): string {
    if (!/^[a-f0-9]{64}$/.test(fileKey)) throw new DesignToHarmonyError("INVALID_ARGUMENT", "Invalid Octo source id", { status: 400 });
    return join(this.root, `${fileKey}.json`);
  }

  importJson(text: string, originalFileName: string, now = new Date()): StoredOctoSource {
    if (!text || Buffer.byteLength(text, "utf8") > MAX_OCTO_SOURCE_BYTES) {
      throw new DesignToHarmonyError("SOURCE_RESPONSE_TOO_LARGE", "Octo JSON must be between 1 byte and 16 MB", { status: 413, stage: "import" });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (error) {
      throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "The selected Octo export is not valid JSON", { status: 422, stage: "import", cause: error });
    }
    if (!isRecord(parsed)) {
      throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "The Octo export must contain one design document object", { status: 422, stage: "import" });
    }
    normalizeOctoPayload(parsed);
    const fileKey = createHash("sha256").update(text).digest("hex");
    const path = this.path(fileKey);
    if (existsSync(path)) return this.get(fileKey);
    const timestamp = now.toISOString();
    const source: StoredOctoSource = {
      schemaVersion: 1,
      fileKey,
      originalFileName: safeOriginalFileName(originalFileName),
      importedAt: timestamp,
      version: { id: fileKey, lastModified: timestamp },
      payload: parsed,
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path, `${JSON.stringify(source)}\n`);
    return source;
  }

  get(fileKey: string): StoredOctoSource {
    const path = this.path(fileKey);
    if (!existsSync(path)) throw new DesignToHarmonyError("SOURCE_NOT_FOUND", "The imported Octo design data is no longer available", { status: 404, stage: "source" });
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredOctoSource>;
      if (value.schemaVersion !== 1 || value.fileKey !== fileKey || !value.version || !isRecord(value.payload) || typeof value.originalFileName !== "string") throw new Error("invalid source record");
      return value as StoredOctoSource;
    } catch (error) {
      if (error instanceof DesignToHarmonyError) throw error;
      throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "The stored Octo design data is corrupt", { status: 500, stage: "source", cause: error });
    }
  }
}

export function octoSourceRef(source: StoredOctoSource): DesignSourceRef {
  return {
    provider: "octo",
    fileKey: source.fileKey,
    url: `octo://local/${source.fileKey}`,
    transport: "file",
    originalFileName: source.originalFileName,
  };
}

export class OctoSourceAdapter implements DesignSourceAdapter {
  private readonly store: OctoSourceStore;

  constructor(options: { root?: string } = {}) {
    this.store = new OctoSourceStore(options.root);
  }

  private read(ref: DesignSourceRef): { source: StoredOctoSource; normalized: NormalizedOctoPayload } {
    if (ref.provider !== "octo") throw new DesignToHarmonyError("INVALID_ARGUMENT", "Octo adapter received a different design source", { status: 400 });
    const source = this.store.get(ref.fileKey);
    return { source, normalized: normalizeOctoPayload(source.payload) };
  }

  async getDocumentSummary(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignDocumentSummary> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
    const { source, normalized } = this.read(ref);
    const summary = normalizeFigmaDocumentSummary({
      document: normalized.document,
      name: normalized.name,
      version: source.version.id,
      lastModified: source.version.lastModified,
      editorType: "octo",
      components: normalized.components,
      componentSets: normalized.componentSets,
      styles: normalized.styles,
    }, ref, normalized.variables);
    return {
      ...summary,
      warnings: [...summary.warnings, "Octo JSON was imported structurally. Image exports and visual reference renders require an Octo asset package and currently use explicit placeholders."],
    };
  }

  async getNodes(ref: DesignSourceRef, nodeIds: string[], signal?: AbortSignal, versionId?: string): Promise<DesignSourceNodePayload[]> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
    const { source, normalized } = this.read(ref);
    if (versionId && source.version.id !== versionId) {
      throw new DesignToHarmonyError("SOURCE_VERSION_CHANGED", "The Octo source version no longer matches this analysis", { status: 409, retryable: true, stage: "source" });
    }
    return [...new Set(nodeIds)].flatMap((id) => {
      const node = findNode(normalized.document, id);
      return node ? [{ id, document: node }] : [];
    });
  }

  async getVariables(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignVariableCatalog> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
    return this.read(ref).normalized.variables;
  }

  async exportAssets(_ref: DesignSourceRef, requests: DesignAssetRequest[]): Promise<DesignAssetResult[]> {
    return requests.map((request) => ({ nodeId: request.nodeId, url: null }));
  }

  async renderReference(_ref: DesignSourceRef, nodeIds: string[]): Promise<DesignReferenceRender[]> {
    return nodeIds.map((nodeId) => ({ nodeId, url: null }));
  }

  async getVersion(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignSourceVersion> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
    return this.read(ref).source.version;
  }
}

export const OCTO_JSON_MAX_BYTES = MAX_OCTO_SOURCE_BYTES;
