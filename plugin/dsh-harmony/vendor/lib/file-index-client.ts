import { buildEntriesFromFiles, type FileIndexEntry } from "./file-fuzzy";

export interface ClientFileIndex {
  cwd: string;
  entries: FileIndexEntry[];
  truncated: boolean;
}

// Share the index across composers/sessions for the same directory. An expired
// index remains usable while one deduplicated request refreshes it.
const cache = new Map<string, { index: ClientFileIndex; fetchedAt: number }>();
const pending = new Map<string, Promise<ClientFileIndex>>();
const TTL_MS = 10_000;
const MAX_PROJECTS = 12;

export function getCachedFileIndex(cwd: string): ClientFileIndex | null {
  const entry = cache.get(cwd);
  if (!entry) return null;
  cache.delete(cwd);
  cache.set(cwd, entry);
  return entry.index;
}

export function loadFileIndex(cwd: string): Promise<ClientFileIndex> {
  const entry = cache.get(cwd);
  if (entry && Date.now() - entry.fetchedAt < TTL_MS) return Promise.resolve(entry.index);
  const active = pending.get(cwd);
  if (active) return active;
  const request = fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`file index failed: ${response.status}`);
      const data = await response.json() as { files?: string[]; truncated?: boolean };
      const index = { cwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated };
      cache.delete(cwd);
      cache.set(cwd, { index, fetchedAt: Date.now() });
      if (cache.size > MAX_PROJECTS) cache.delete(cache.keys().next().value!);
      return index;
    }).finally(() => { pending.delete(cwd); });
  pending.set(cwd, request);
  return request;
}
