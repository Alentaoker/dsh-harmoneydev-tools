export interface BufferedLog { id: number; raw: string; message: string; tag?: string; domain?: string }
/** Limits stored text payload and row count; DOM virtualization has its own bound. */
export function retainLogBatch<T extends BufferedLog>(previous: T[], added: T[], maxRows = 10000, maxBytes = 8 * 1024 * 1024) {
  const entries = previous.concat(added); let bytes = 0;
  const size = (entry: T) => 2 * (entry.raw.length + entry.message.length + (entry.tag?.length ?? 0) + (entry.domain?.length ?? 0));
  let start = Math.max(0, entries.length - maxRows);
  for (let index = start; index < entries.length; index++) bytes += size(entries[index]);
  while (start < entries.length && bytes > maxBytes) bytes -= size(entries[start++]);
  return { entries: entries.slice(start), removed: start, bytes };
}
