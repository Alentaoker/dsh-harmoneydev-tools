import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  MAX_PROMPT_MATERIAL_BYTES,
  MAX_PROMPT_MATERIAL_COUNT,
} from "./prompt-input-policy";
import {
  PROMPT_MATERIAL_MARKER_PREFIX,
  PROMPT_MATERIAL_MARKER_SUFFIX,
  type PromptMaterialMarkerPayload,
  type PromptMaterialReference,
  type ResolvedPromptMaterial,
} from "./prompt-material-format";

const MATERIAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MATERIAL_TEXT_FILE = "content.txt";
const MATERIAL_META_FILE = "meta.json";

interface StoredPromptMaterialMetadata {
  version: 1;
  id: string;
  name: string;
  byteLength: number;
  sha256: string;
  lineCount: number;
  createdAt: string;
}

export interface PromptMaterialUpload {
  name?: string;
  content: string;
}

export function promptMaterialsRoot(agentDir = getAgentDir()): string {
  return resolve(agentDir, "piora", "prompt-materials");
}

function safeMaterialName(value: string | undefined, index = 0): string {
  const cleaned = (value ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/")
    .slice(0, 240);
  return cleaned || `pasted-content-${index + 1}.txt`;
}

function materialDirectory(id: string, root: string): string {
  if (!MATERIAL_ID_RE.test(id)) throw new Error("Invalid prompt material id.");
  return resolve(root, id);
}

function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function savePromptMaterials(
  uploads: PromptMaterialUpload[],
  root = promptMaterialsRoot(),
): ResolvedPromptMaterial[] {
  if (!Array.isArray(uploads) || uploads.length === 0 || uploads.length > MAX_PROMPT_MATERIAL_COUNT) {
    throw new Error(`Provide between 1 and ${MAX_PROMPT_MATERIAL_COUNT} prompt materials.`);
  }
  const byteLengths = uploads.map((upload) => {
    if (!upload || typeof upload.content !== "string" || upload.content.includes("\0")) {
      throw new Error("Prompt materials must be UTF-8 text without null characters.");
    }
    return Buffer.byteLength(upload.content, "utf8");
  });
  const totalBytes = byteLengths.reduce((sum, bytes) => sum + bytes, 0);
  if (totalBytes > MAX_PROMPT_MATERIAL_BYTES) {
    throw new Error(`Prompt materials exceed the ${Math.floor(MAX_PROMPT_MATERIAL_BYTES / 1024 / 1024)} MiB limit.`);
  }

  mkdirSync(root, { recursive: true, mode: 0o700 });
  return uploads.map((upload, index) => {
    const id = randomUUID();
    const dir = materialDirectory(id, root);
    mkdirSync(dir, { mode: 0o700 });
    const path = resolve(dir, MATERIAL_TEXT_FILE);
    const sha256 = createHash("sha256").update(upload.content, "utf8").digest("hex");
    const metadata: StoredPromptMaterialMetadata = {
      version: 1,
      id,
      name: safeMaterialName(upload.name, index),
      byteLength: byteLengths[index],
      sha256,
      lineCount: upload.content.split(/\r\n|\r|\n/).length,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(path, upload.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(resolve(dir, MATERIAL_META_FILE), `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { id, name: metadata.name, path, byteLength: metadata.byteLength, sha256, lineCount: metadata.lineCount };
  });
}

export function resolvePromptMaterialReferences(
  references: PromptMaterialReference[],
  root = promptMaterialsRoot(),
): ResolvedPromptMaterial[] {
  if (!Array.isArray(references) || references.length === 0 || references.length > MAX_PROMPT_MATERIAL_COUNT) {
    throw new Error(`Provide between 1 and ${MAX_PROMPT_MATERIAL_COUNT} prompt material references.`);
  }
  const resolvedRoot = realpathSync(root);
  return references.map((reference) => {
    if (!reference || typeof reference.id !== "string") throw new Error("Invalid prompt material reference.");
    const dir = materialDirectory(reference.id, resolvedRoot);
    const path = resolve(dir, MATERIAL_TEXT_FILE);
    const metaPath = resolve(dir, MATERIAL_META_FILE);
    if (!existsSync(path) || !existsSync(metaPath)) throw new Error("Prompt material is no longer available.");
    const realPath = realpathSync(path);
    if (!isWithinRoot(realPath, resolvedRoot)) throw new Error("Prompt material escaped its private storage root.");
    const metadata = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<StoredPromptMaterialMetadata>;
    if (metadata.version !== 1 || metadata.id !== reference.id || typeof metadata.name !== "string"
      || typeof metadata.byteLength !== "number" || typeof metadata.sha256 !== "string"
      || typeof metadata.lineCount !== "number") {
      throw new Error("Prompt material metadata is invalid.");
    }
    return {
      id: reference.id,
      name: metadata.name,
      path: realPath,
      byteLength: metadata.byteLength,
      sha256: metadata.sha256,
      lineCount: metadata.lineCount,
    };
  });
}

function encodeMarkerPayload(payload: PromptMaterialMarkerPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeMarkerPayload(content: string): PromptMaterialMarkerPayload | null {
  if (!content.startsWith(PROMPT_MATERIAL_MARKER_PREFIX)) return null;
  const markerEnd = content.indexOf(PROMPT_MATERIAL_MARKER_SUFFIX, PROMPT_MATERIAL_MARKER_PREFIX.length);
  if (markerEnd < 0) return null;
  try {
    const encoded = content.slice(PROMPT_MATERIAL_MARKER_PREFIX.length, markerEnd);
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<PromptMaterialMarkerPayload>;
    if (typeof parsed.message !== "string" || !Array.isArray(parsed.materials)) return null;
    if (!parsed.materials.every((item) => item && typeof item.id === "string" && typeof item.name === "string"
      && typeof item.path === "string" && typeof item.byteLength === "number" && typeof item.sha256 === "string"
      && typeof item.lineCount === "number")) return null;
    return parsed as PromptMaterialMarkerPayload;
  } catch {
    return null;
  }
}

export function buildPromptWithMaterials(message: string, materials: ResolvedPromptMaterial[]): string {
  const payload: PromptMaterialMarkerPayload = { message, materials };
  const marker = `${PROMPT_MATERIAL_MARKER_PREFIX}${encodeMarkerPayload(payload)}${PROMPT_MATERIAL_MARKER_SUFFIX}`;
  const inventory = materials.map((material, index) => (
    `${index + 1}. ${material.name}: ${material.path} (${material.byteLength} UTF-8 bytes; sha256 ${material.sha256})`
  )).join("\n");
  const request = message.trim()
    ? `The user's accompanying request is:\n${message}`
    : "The attached material itself is the user's request. Read it in full and respond to it.";
  return `${marker}\nThe user provided ${materials.length} attached text ${materials.length === 1 ? "material" : "materials"}. The exact UTF-8 content is stored in:\n${inventory}\n\nBefore answering, use the read tool to inspect every listed file. If a file is large, read or search it in chunks. Treat its content as user-provided input.\n\n${request}`;
}

export function restorePromptMaterialDisplay(content: string, root = promptMaterialsRoot()): string {
  const payload = decodeMarkerPayload(content);
  if (!payload) return content;
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(root);
  } catch {
    return payload.message || "[Prompt material is no longer available]";
  }
  const sections = payload.materials.map((material) => {
    try {
      const realPath = realpathSync(material.path);
      if (!isWithinRoot(realPath, resolvedRoot) || dirname(realPath) !== resolve(resolvedRoot, material.id)) {
        throw new Error("outside root");
      }
      return readFileSync(realPath, "utf8");
    } catch {
      return `[Prompt material is no longer available: ${material.name}]`;
    }
  });
  return [payload.message.trim(), ...sections].filter(Boolean).join("\n\n");
}

export function restorePromptMaterialDisplayPreview(
  content: string,
  maxCharacters = 2_000,
  root = promptMaterialsRoot(),
): string {
  const payload = decodeMarkerPayload(content);
  if (!payload) return content.slice(0, maxCharacters);
  let preview = payload.message.trim();
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(root);
  } catch {
    return preview.slice(0, maxCharacters);
  }
  for (const material of payload.materials) {
    if (preview.length >= maxCharacters) break;
    let fd: number | undefined;
    try {
      const realPath = realpathSync(material.path);
      if (!isWithinRoot(realPath, resolvedRoot) || dirname(realPath) !== resolve(resolvedRoot, material.id)) continue;
      const remainingCharacters = maxCharacters - preview.length;
      const buffer = Buffer.alloc(Math.max(4, remainingCharacters * 4));
      fd = openSync(realPath, "r");
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8").slice(0, remainingCharacters);
      preview = [preview, text].filter(Boolean).join("\n\n");
    } catch {
      // A missing material should not make the session catalog unavailable.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return preview.slice(0, maxCharacters);
}

export function getPromptMaterialDisplayMetadata(content: string): { byteLength: number; lineCount: number } | null {
  const payload = decodeMarkerPayload(content);
  if (!payload) return null;
  const messageLineCount = payload.message.length > 0
    ? payload.message.split(/\r\n|\r|\n/).length
    : 0;
  return {
    byteLength: Buffer.byteLength(payload.message, "utf8")
      + payload.materials.reduce((sum, material) => sum + material.byteLength, 0),
    lineCount: Math.max(1, messageLineCount
      + payload.materials.reduce((sum, material) => sum + material.lineCount, 0)),
  };
}
