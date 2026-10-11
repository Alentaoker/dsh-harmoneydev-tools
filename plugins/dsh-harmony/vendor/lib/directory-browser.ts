import { readdir, realpath, stat } from "fs/promises";
import path from "path";
import { getRuntimeHomeDirectory } from "./runtime-home";

export interface BrowsableDirectory {
  name: string;
  path: string;
}

export function getBrowseStartDirectory(directory?: string): string {
  return directory || getRuntimeHomeDirectory();
}

export function normalizeDirectory(directory: string): string {
  if (directory === "~") return getRuntimeHomeDirectory();
  if (directory.startsWith("~/")) return path.resolve(getRuntimeHomeDirectory(), directory.slice(2));
  return path.resolve(directory);
}

export function getParentDirectory(directory: string): string | null {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
    ? path.win32
    : directory.startsWith("/")
      ? path.posix
      : path;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return realpath(normalizeDirectory(directory));
}

export async function listDirectories(directory: string): Promise<BrowsableDirectory[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  // 忽略损坏、不可访问或不指向目录的符号链接。
  const candidates = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return { name: entry.name, path: path.join(directory, entry.name) };
    }
    if (!entry.isSymbolicLink()) return null;

    try {
      const entryPath = path.join(directory, entry.name);
      const realEntryPath = await realpath(entryPath);
      const entryStat = await stat(realEntryPath);
      if (!entryStat.isDirectory()) return null;
      return { name: entry.name, path: entryPath };
    } catch {
      return null;
    }
  }));

  return candidates
    .filter((entry): entry is BrowsableDirectory => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Enumerates the currently mounted Windows drive roots (C:\, D:\, ...).
 * Unreadable or media-less drives are skipped.
 */
export async function listWindowsDrives(): Promise<BrowsableDirectory[]> {
  const drives: BrowsableDirectory[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      const driveStat = await stat(root);
      if (driveStat.isDirectory()) {
        drives.push({ name: root, path: root });
      }
    } catch {
      // Skip drives that cannot be stat'ed (for example empty card readers).
    }
  }
  return drives;
}
