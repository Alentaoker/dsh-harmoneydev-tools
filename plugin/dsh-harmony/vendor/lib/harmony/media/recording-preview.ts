export const RECORDING_BLOB_LIMIT = 16 * 1024 * 1024;

/** Small recordings use a normal fetch, avoiding Chromium's deferred media
 * request queue while live streams are open. Large files keep range playback. */
export async function prepareRecordingPreview(url: string, size: number, signal: AbortSignal) {
  const direct = { url, dispose() {} };
  if (!Number.isSafeInteger(size) || size < 1 || size > RECORDING_BLOB_LIMIT) return direct;
  const response = await fetch(url, { signal, cache: 'no-store', priority: 'high' });
  if (!response.ok) throw Error('录屏加载失败，请关闭后重试');
  const length = Number(response.headers.get('Content-Length'));
  if (length > RECORDING_BLOB_LIMIT) {
    await response.body?.cancel();
    return direct;
  }
  if (!response.body) throw Error('录屏内容为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > RECORDING_BLOB_LIMIT) { await reader.cancel(); return direct; }
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    const objectUrl = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'video/mp4' }));
    let disposed = false;
    return { url: objectUrl, dispose() { if (!disposed) { disposed = true; URL.revokeObjectURL(objectUrl); } } };
  } finally { reader.releaseLock(); }
}
