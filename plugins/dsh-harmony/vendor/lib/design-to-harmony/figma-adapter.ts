import { DesignToHarmonyError } from "./errors";
import type { DesignSourceAdapter } from "./source-adapter";
import type {
  DesignAssetRequest,
  DesignAssetResult,
  DesignComponentSummary,
  DesignDocumentSummary,
  DesignFlowSummary,
  DesignReferenceRender,
  DesignSourceNodePayload,
  DesignSourceRef,
  DesignSourceVersion,
  DesignStyleSummary,
  DesignTreeNodeSummary,
  DesignVariableCatalog,
  DesignVariableCollectionSummary,
  DesignVariableSummary,
  DesignNodeType,
} from "./types";

const FIGMA_API_ORIGIN = "https://api.figma.com";
const FIGMA_REQUEST_TIMEOUT_MS = 30_000;
const FIGMA_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_NODE_IDS_PER_REQUEST = 100;

type FetchLike = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordEntries(value: unknown): Array<[string, Record<string, unknown>]> {
  if (!isRecord(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
}

function normalizeNodeId(value: string): string {
  return value.includes(":") ? value : value.replace(/-/g, ":");
}

function canonicalFigmaUrl(fileKey: string, nodeId?: string): string {
  const url = new URL(`https://www.figma.com/design/${encodeURIComponent(fileKey)}/piora-design`);
  if (nodeId) url.searchParams.set("node-id", nodeId.replace(/:/g, "-"));
  return url.toString();
}

export function parseFigmaSourceUrl(value: unknown): DesignSourceRef {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "Enter a valid Figma file or node link", { status: 400 });
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "Enter a valid Figma file or node link", { status: 400 });
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || (hostname !== "figma.com" && hostname !== "www.figma.com")) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "Only https://www.figma.com file links are supported", { status: 400 });
  }
  if (url.username || url.password) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "Figma links cannot include credentials", { status: 400 });
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const fileType = segments[0]?.toLowerCase();
  const fileKey = segments[1] ?? "";
  if (!fileType || !["design", "file", "proto", "board"].includes(fileType) || !/^[A-Za-z0-9_-]{6,128}$/.test(fileKey)) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "The Figma link does not contain a valid file key", { status: 400 });
  }

  const rawNodeId = url.searchParams.get("node-id")?.trim();
  const nodeId = rawNodeId ? normalizeNodeId(rawNodeId) : undefined;
  if (nodeId && !/^[A-Za-z0-9_.:-]{1,256}$/.test(nodeId)) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "The Figma node id is invalid", { status: 400 });
  }

  return {
    provider: "figma",
    fileKey,
    ...(nodeId ? { nodeId } : {}),
    url: canonicalFigmaUrl(fileKey, nodeId),
  };
}

function normalizeNodeType(value: unknown): DesignNodeType {
  const type = typeof value === "string" ? value.toUpperCase() : "UNKNOWN";
  const supported: ReadonlySet<string> = new Set([
    "DOCUMENT", "CANVAS", "SECTION", "FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE",
    "TEXT", "VECTOR", "RECTANGLE", "ELLIPSE", "LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION",
    "SLICE", "STAMP", "HIGHLIGHT", "WASHI_TAPE", "SHAPE_WITH_TEXT", "CODE_BLOCK", "CONNECTOR",
    "WIDGET", "EMBED", "LINK_UNFURL", "MEDIA",
  ]);
  return supported.has(type) ? type as DesignNodeType : "UNKNOWN";
}

function summarizeNode(value: unknown, depth = 0): DesignTreeNodeSummary | null {
  if (!isRecord(value) || depth > 64) return null;
  const id = optionalString(value.id);
  if (!id) return null;
  const rawChildren = Array.isArray(value.children) ? value.children : [];
  const children = rawChildren
    .map((child) => summarizeNode(child, depth + 1))
    .filter((child): child is DesignTreeNodeSummary => child !== null);
  return {
    id,
    name: stringValue(value.name, "Untitled"),
    type: normalizeNodeType(value.type),
    visible: value.visible !== false,
    childCount: rawChildren.length,
    children,
  };
}

function normalizeComponentEntries(value: unknown): DesignComponentSummary[] {
  return recordEntries(value).map(([nodeId, component]) => ({
    nodeId,
    ...(optionalString(component.key) ? { key: optionalString(component.key) } : {}),
    name: stringValue(component.name, nodeId),
    ...(optionalString(component.description) ? { description: optionalString(component.description) } : {}),
    ...(optionalString(component.componentSetId) ? { componentSetId: optionalString(component.componentSetId) } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name) || a.nodeId.localeCompare(b.nodeId));
}

function normalizeStyleEntries(value: unknown): DesignStyleSummary[] {
  return recordEntries(value).map(([nodeId, style]) => ({
    nodeId,
    ...(optionalString(style.key) ? { key: optionalString(style.key) } : {}),
    name: stringValue(style.name, nodeId),
    ...(optionalString(style.styleType) ? { styleType: optionalString(style.styleType) } : {}),
    ...(optionalString(style.description) ? { description: optionalString(style.description) } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name) || a.nodeId.localeCompare(b.nodeId));
}

function normalizeModes(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((mode) => {
    if (!isRecord(mode) || typeof mode.modeId !== "string") return [];
    return [{ id: mode.modeId, name: stringValue(mode.name, mode.modeId) }];
  });
}

export function normalizeFigmaVariables(value: unknown): DesignVariableCatalog {
  if (!isRecord(value) || !isRecord(value.meta)) {
    return { availability: "unavailable", collections: [], variables: [], reason: "Figma variables were not returned" };
  }
  const meta = value.meta;
  const collections: DesignVariableCollectionSummary[] = recordEntries(meta.variableCollections).map(([id, collection]) => ({
    id,
    ...(optionalString(collection.key) ? { key: optionalString(collection.key) } : {}),
    name: stringValue(collection.name, id),
    modes: normalizeModes(collection.modes),
    variableIds: Array.isArray(collection.variableIds)
      ? collection.variableIds.filter((item): item is string => typeof item === "string")
      : [],
  })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const variables: DesignVariableSummary[] = recordEntries(meta.variables).map(([id, variable]) => {
    const resolvedType = stringValue(variable.resolvedType).toUpperCase();
    const normalizedType: DesignVariableSummary["resolvedType"] = ["BOOLEAN", "FLOAT", "STRING", "COLOR"].includes(resolvedType)
      ? resolvedType as DesignVariableSummary["resolvedType"]
      : "UNKNOWN";
    return {
      id,
      ...(optionalString(variable.key) ? { key: optionalString(variable.key) } : {}),
      name: stringValue(variable.name, id),
      collectionId: stringValue(variable.variableCollectionId),
      resolvedType: normalizedType,
      remote: variable.remote === true,
      ...(optionalString(variable.description) ? { description: optionalString(variable.description) } : {}),
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  return { availability: "available", collections, variables };
}

function flowSummaries(page: Record<string, unknown>): DesignFlowSummary[] {
  if (!Array.isArray(page.flowStartingPoints) || typeof page.id !== "string") return [];
  const pageId = page.id;
  return page.flowStartingPoints.flatMap((flow, index) => {
    if (!isRecord(flow) || typeof flow.nodeId !== "string") return [];
    return [{
      id: `${pageId}:${flow.nodeId}:${index}`,
      name: stringValue(flow.name, `Flow ${index + 1}`),
      nodeId: flow.nodeId,
      pageId,
    }];
  });
}

export function normalizeFigmaDocumentSummary(
  value: unknown,
  source: DesignSourceRef,
  variables: DesignVariableCatalog = { availability: "not_requested", collections: [], variables: [] },
): DesignDocumentSummary {
  if (!isRecord(value) || !isRecord(value.document)) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned an invalid document", { status: 502, retryable: true });
  }
  const document = value.document;
  const rootId = optionalString(document.id);
  const name = optionalString(value.name);
  const version = optionalString(value.version);
  const lastModified = optionalString(value.lastModified);
  if (!rootId || !name || !version || !lastModified) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma document metadata is incomplete", { status: 502, retryable: true });
  }

  const rawPages = Array.isArray(document.children) ? document.children.filter(isRecord) : [];
  const pages = rawPages
    .filter((page) => page.type === "CANVAS")
    .map((page) => summarizeNode(page))
    .filter((page): page is DesignTreeNodeSummary => page !== null);
  const components = normalizeComponentEntries(value.components);
  const componentSets = normalizeComponentEntries(value.componentSets);
  const styles = normalizeStyleEntries(value.styles);
  const flows = rawPages.flatMap(flowSummaries);
  const warnings: string[] = [];
  if (variables.availability === "unavailable") {
    warnings.push(variables.reason ?? "Design variables are unavailable for this Figma account or token");
  }
  if (source.nodeId) warnings.push("The source link targets one node; the file tree is still shown for navigation");
  const topLevelNodes = pages.reduce((total, page) => total + page.childCount, 0);

  return {
    rootId,
    name,
    version: { id: version, lastModified },
    ...(optionalString(value.editorType) ? { editorType: optionalString(value.editorType) } : {}),
    ...(optionalString(value.thumbnailUrl) ? { thumbnailUrl: optionalString(value.thumbnailUrl) } : {}),
    pages,
    components,
    componentSets,
    styles,
    variables,
    flows,
    counts: {
      pages: pages.length,
      topLevelNodes,
      components: components.length,
      componentSets: componentSets.length,
      styles: styles.length,
      variables: variables.variables.length,
      flows: flows.length,
    },
    warnings,
  };
}

async function readJsonWithinLimit(response: Response, maxBytes = FIGMA_MAX_RESPONSE_BYTES): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DesignToHarmonyError("SOURCE_RESPONSE_TOO_LARGE", "Figma response is too large; select fewer nodes", {
      status: 413,
      details: { maxBytes },
    });
  }
  if (!response.body) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned an empty response", { status: 502, retryable: true });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DesignToHarmonyError("SOURCE_RESPONSE_TOO_LARGE", "Figma response is too large; select fewer nodes", {
          status: 413,
          details: { maxBytes },
        });
      }
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned invalid JSON", {
      status: 502,
      retryable: true,
      cause: error,
    });
  }
}

function safeUpgradeUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && (hostname === "figma.com" || hostname.endsWith(".figma.com"))
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function figmaHttpError(response: Response): DesignToHarmonyError {
  if (response.status === 401 || response.status === 403) {
    return new DesignToHarmonyError("SOURCE_AUTH_FAILED", "Figma access was denied. Check the token, scopes, and file permission", {
      status: response.status,
    });
  }
  if (response.status === 404) {
    return new DesignToHarmonyError("SOURCE_NOT_FOUND", "The Figma file or node was not found", { status: 404 });
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const upgradeUrl = safeUpgradeUrl(response.headers.get("x-figma-upgrade-link"));
    return new DesignToHarmonyError("SOURCE_RATE_LIMITED", "Figma rate limit reached. Use the cached design or retry later", {
      status: 429,
      retryable: true,
      details: {
        ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSec: retryAfter } : {}),
        ...(upgradeUrl ? { upgradeUrl } : {}),
      },
    });
  }
  return new DesignToHarmonyError("SOURCE_REQUEST_FAILED", `Figma request failed with status ${response.status}`, {
    status: response.status >= 500 ? 502 : 400,
    retryable: response.status >= 500,
    details: { upstreamStatus: response.status },
  });
}

function requestSignal(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new DOMException("Figma request timed out", "TimeoutError"));
  }, FIGMA_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
    timedOut: () => timeoutReached,
  };
}

export class FigmaSourceAdapter implements DesignSourceAdapter {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: { token: string; fetchImpl?: FetchLike }) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(pathname: string, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(pathname, FIGMA_API_ORIGIN);
    const request = requestSignal(signal);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { "X-Figma-Token": this.token, Accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: request.signal,
      });
      if (!response.ok) throw figmaHttpError(response);
      return await readJsonWithinLimit(response);
    } catch (error) {
      if (error instanceof DesignToHarmonyError) throw error;
      if (request.signal.aborted) {
        throw new DesignToHarmonyError("SOURCE_ABORTED", request.timedOut() ? "Figma request timed out" : "Design import was cancelled", {
          status: request.timedOut() ? 504 : 499,
          retryable: true,
          cause: error,
        });
      }
      throw new DesignToHarmonyError("SOURCE_REQUEST_FAILED", "Unable to reach Figma", {
        status: 502,
        retryable: true,
        cause: error,
      });
    } finally {
      request.cleanup();
    }
  }

  async getDocumentSummary(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignDocumentSummary> {
    const path = new URL(`/v1/files/${encodeURIComponent(ref.fileKey)}`, FIGMA_API_ORIGIN);
    path.searchParams.set("depth", "2");
    const document = await this.request(`${path.pathname}${path.search}`, signal);
    let variables: DesignVariableCatalog;
    try {
      variables = await this.getVariables(ref, signal);
    } catch (error) {
      if (error instanceof DesignToHarmonyError && error.code === "SOURCE_AUTH_FAILED") {
        variables = {
          availability: "unavailable",
          collections: [],
          variables: [],
          reason: "Figma variables require file_variables:read and may depend on the account plan",
        };
      } else {
        throw error;
      }
    }
    return normalizeFigmaDocumentSummary(document, ref, variables);
  }

  async getNodes(ref: DesignSourceRef, nodeIds: string[], signal?: AbortSignal, versionId?: string): Promise<DesignSourceNodePayload[]> {
    const unique = [...new Set(nodeIds.map((id) => normalizeNodeId(id.trim())).filter(Boolean))];
    if (unique.length === 0 || unique.length > MAX_NODE_IDS_PER_REQUEST) {
      throw new DesignToHarmonyError("INVALID_ARGUMENT", `Select between 1 and ${MAX_NODE_IDS_PER_REQUEST} design nodes`, { status: 400 });
    }
    const path = new URL(`/v1/files/${encodeURIComponent(ref.fileKey)}/nodes`, FIGMA_API_ORIGIN);
    path.searchParams.set("ids", unique.join(","));
    path.searchParams.set("geometry", "paths");
    if (versionId) path.searchParams.set("version", versionId);
    const value = await this.request(`${path.pathname}${path.search}`, signal);
    if (!isRecord(value) || !isRecord(value.nodes)) {
      throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned invalid node data", { status: 502, retryable: true });
    }
    const nodes = value.nodes;
    return unique.flatMap((id) => {
      const node = nodes[id];
      if (!isRecord(node) || !isRecord(node.document)) return [];
      return [{ id, document: node.document }];
    });
  }

  async getVariables(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignVariableCatalog> {
    const value = await this.request(`/v1/files/${encodeURIComponent(ref.fileKey)}/variables/local`, signal);
    return normalizeFigmaVariables(value);
  }

  async exportAssets(ref: DesignSourceRef, requests: DesignAssetRequest[], signal?: AbortSignal): Promise<DesignAssetResult[]> {
    if (requests.length === 0 || requests.length > MAX_NODE_IDS_PER_REQUEST) {
      throw new DesignToHarmonyError("INVALID_ARGUMENT", `Select between 1 and ${MAX_NODE_IDS_PER_REQUEST} assets`, { status: 400 });
    }
    const results = new Map<string, string | null>();
    const groups = new Map<string, DesignAssetRequest[]>();
    for (const request of requests) {
      const scale = Math.max(0.01, Math.min(4, request.scale ?? 1));
      const key = `${request.format}:${scale}`;
      groups.set(key, [...(groups.get(key) ?? []), { ...request, scale }]);
    }
    for (const [groupKey, group] of groups) {
      const [format, scale] = groupKey.split(":");
      const path = new URL(`/v1/images/${encodeURIComponent(ref.fileKey)}`, FIGMA_API_ORIGIN);
      path.searchParams.set("ids", group.map((request) => normalizeNodeId(request.nodeId)).join(","));
      path.searchParams.set("format", format);
      path.searchParams.set("scale", scale);
      const value = await this.request(`${path.pathname}${path.search}`, signal);
      const images = isRecord(value) && isRecord(value.images) ? value.images : {};
      for (const request of group) {
        const nodeId = normalizeNodeId(request.nodeId);
        results.set(nodeId, typeof images[nodeId] === "string" ? images[nodeId] as string : null);
      }
    }
    return requests.map((request) => {
      const nodeId = normalizeNodeId(request.nodeId);
      return { nodeId, url: results.get(nodeId) ?? null };
    });
  }

  async renderReference(ref: DesignSourceRef, nodeIds: string[], signal?: AbortSignal): Promise<DesignReferenceRender[]> {
    const assets = await this.exportAssets(ref, nodeIds.map((nodeId) => ({ nodeId, format: "png", scale: 1 })), signal);
    return assets.map(({ nodeId, url }) => ({ nodeId, url }));
  }

  async getImageFills(ref: DesignSourceRef, signal?: AbortSignal): Promise<import("./types").DesignImageFillResult[]> {
    const value = await this.request(`/v1/files/${encodeURIComponent(ref.fileKey)}/images`, signal);
    const images = isRecord(value) && isRecord(value.meta) && isRecord(value.meta.images) ? value.meta.images : {};
    return Object.entries(images).map(([imageRef, url]) => ({ imageRef, url: typeof url === "string" ? url : null }))
      .sort((left, right) => left.imageRef.localeCompare(right.imageRef));
  }

  async getVersion(ref: DesignSourceRef, signal?: AbortSignal): Promise<DesignSourceVersion> {
    const value = await this.request(`/v1/files/${encodeURIComponent(ref.fileKey)}/meta`, signal);
    if (!isRecord(value) || !isRecord(value.file)) {
      throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma returned invalid file metadata", { status: 502, retryable: true });
    }
    const id = optionalString(value.file.version);
    const lastModified = optionalString(value.file.last_touched_at);
    if (!id || !lastModified) {
      throw new DesignToHarmonyError("SOURCE_INVALID_RESPONSE", "Figma file metadata is incomplete", { status: 502, retryable: true });
    }
    return { id, lastModified };
  }
}
