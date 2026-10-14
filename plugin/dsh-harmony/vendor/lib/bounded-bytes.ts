export class ByteBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the allowed size");
  }
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

/** Read an arbitrary request body while bounding both declared and chunked data. */
export async function readBytesWithinLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = declaredContentLength(request);
  if (declared !== null && declared > maxBytes) throw new ByteBodyTooLargeError();

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ByteBodyTooLargeError();
      }
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy);
      size += copy.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
