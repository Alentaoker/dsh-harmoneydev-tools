import { lstat, opendir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveHarmonyStorage, safeHarmonyDeviceName } from "./artifacts";
import { HarmonyError } from "./errors";
import type { HarmonyConfig, HarmonyMediaArtifact } from "./types";

const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_HISTORY = 40;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type Candidate = { kind: "screenshot" | "recording"; directory: string; filename: string; createdAt: string };

function generatedTime(filename: string, prefix: string, extension: "png" | "mp4"): string | undefined {
  if (!filename.startsWith(`${prefix}-`)) return;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}\.(png|mp4)$/.exec(filename.slice(prefix.length + 1));
  if (!match || match[6] !== extension) return;
  const timestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

async function screenshotSize(path: string): Promise<{ width: number; height: number } | undefined> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(24);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length || !header.subarray(0, 8).equals(PNG_HEADER)
      || header.toString("ascii", 12, 16) !== "IHDR") return;
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (!width || !height || width > 16_384 || height > 16_384) return;
    return { width, height };
  } finally { await file.close(); }
}

/** Rediscover saved results from the configured private media folders after a desktop restart. */
export async function listHarmonyMediaHistory(config: HarmonyConfig, serial: string, scope: "all" | "manual" | "legacy" = "all", limit = MAX_HISTORY): Promise<{ artifacts: HarmonyMediaArtifact[]; truncated: boolean }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HarmonyError("INVALID_ARGUMENT", "History limit must be 1–1000");
  if (!/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial)) throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid device");
  const prefix = safeHarmonyDeviceName(serial);
  const storage = resolveHarmonyStorage(config);
  const folders = [{ kind: "screenshot" as const, directory: storage.screenshotDirectory, extension: "png" as const },
    { kind: "recording" as const, directory: storage.recordingDirectory, extension: "mp4" as const }];
  const candidates: Candidate[] = [];
  let truncated = false;
  for (const folder of folders) {
    if (!isAbsolute(folder.directory)) throw new HarmonyError("INVALID_ARGUMENT", "Harmony media storage paths must be absolute");
    const info = await lstat(folder.directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Media history directory is not a regular directory");
    const directory = await opendir(folder.directory);
    let scanned = 0;
    try {
      for await (const entry of directory) {
        if (++scanned > MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
        if (!entry.isFile()) continue;
        const createdAt = generatedTime(entry.name, prefix, folder.extension);
        if (createdAt) candidates.push({ kind: folder.kind, directory: folder.directory, filename: entry.name, createdAt });
      }
    } finally { await directory.close().catch(() => undefined); }
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const artifacts: HarmonyMediaArtifact[] = [];
  for (const candidate of candidates) {
    const path = join(candidate.directory, candidate.filename);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size < 1) continue;
    const dimensions = candidate.kind === "screenshot" ? await screenshotSize(path).catch(() => undefined) : undefined;
    if (candidate.kind === "screenshot" && (!dimensions || info.size > 20 * 1024 * 1024)) continue;
    const marker = await lstat(path + '.origin.json').catch(() => undefined);
    let source: 'manual' | 'automation' | 'unknown' = 'unknown';
    if (marker?.isFile() && !marker.isSymbolicLink() && marker.size < 4096) {
      try { const origin = JSON.parse(await readFile(path + '.origin.json', 'utf8')); if (origin.filename === candidate.filename && ['manual', 'automation'].includes(origin.source)) source = origin.source; } catch {}
    }
    if (scope === 'manual' && source !== 'manual' || scope === 'legacy' && source !== 'unknown') continue;
    artifacts.push({ source, kind: candidate.kind, serial, path, filename: candidate.filename,
      createdAt: candidate.createdAt, size: info.size, ...(dimensions ?? {}), mimeType: candidate.kind === "screenshot" ? "image/png" : "video/mp4" });
    if (artifacts.length > limit) { artifacts.pop(); truncated = true; break; }
  }
  return { artifacts, truncated };
}

/** Delete only explicitly selected, generated files from this device's configured media roots. */
export async function deleteHarmonyMedia(config: HarmonyConfig, serial: string, items: Array<{ kind: string; filename: string }>, scope: "manual" | "legacy" = "manual") {
  if (typeof serial !== "string" || !/^[A-Za-z0-9._:\[\]-]{1,256}$/.test(serial) || !Array.isArray(items) || !items.length || items.length > 1000
    || !["manual", "legacy"].includes(scope)) throw new HarmonyError("INVALID_ARGUMENT", "Choose 1–1000 saved media files");
  const storage = resolveHarmonyStorage(config), prefix = safeHarmonyDeviceName(serial);
  const targets: Array<{ filename: string; path: string; size: number; markerBytes: number; marker: boolean }> = [], seen = new Set<string>();
  // Validate the entire selection before deleting the first file. Client paths are never accepted.
  for (const item of items) {
    if (!item || !["screenshot", "recording"].includes(item.kind) || typeof item.filename !== "string"
      || !generatedTime(item.filename, prefix, item.kind === "screenshot" ? "png" : "mp4")) throw new HarmonyError("INVALID_ARGUMENT", "Media does not belong to this device");
    if (seen.has(item.filename)) continue; seen.add(item.filename);
    const directory = item.kind === "screenshot" ? storage.screenshotDirectory : storage.recordingDirectory;
    if (!isAbsolute(directory)) throw new HarmonyError("INVALID_ARGUMENT", "Media directory must be absolute");
    const folder = await lstat(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new HarmonyError("INVALID_ARGUMENT", "Invalid media directory");
    const root = await realpath(directory), path = resolve(root, item.filename);
    if (dirname(path) !== root) throw new HarmonyError("INVALID_ARGUMENT", "Media path escapes its directory");
    const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new HarmonyError("INVALID_ARGUMENT", "Media is not a regular file");
    const marker = await lstat(path + '.origin.json').catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (marker && (!marker.isFile() || marker.isSymbolicLink() || marker.size >= 4096)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid media origin");
    let source = "unknown";
    if (marker) { try { const origin = JSON.parse(await readFile(path + '.origin.json', 'utf8')); if (origin.filename === item.filename) source = origin.source; } catch {} }
    if (source !== (scope === "manual" ? "manual" : "unknown")) throw new HarmonyError("INVALID_ARGUMENT", "Only the selected manual or legacy library can be cleared");
    targets.push({ filename: item.filename, path, size: info.size, markerBytes: marker?.size || 0, marker: !!marker });
  }
  const deleted: string[] = [], errors: Array<{ filename: string; error: string }> = []; let freedBytes = 0;
  for (const target of targets) {
    try {
      await unlink(target.path); deleted.push(target.filename); freedBytes += target.size;
      if (target.marker) try { await unlink(target.path + '.origin.json'); freedBytes += target.markerBytes; } catch (error) { if (error.code !== "ENOENT") errors.push({ filename: target.filename, error: "媒体已删除，来源记录清理失败" }); }
    } catch (error) { errors.push({ filename: target.filename, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { deleted, freedBytes, errors };
}
