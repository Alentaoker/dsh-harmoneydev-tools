export class JsonBodyTooLargeError extends Error {
  constructor() {
    super("JSON request body exceeds the allowed size");
  }
}

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON request body");
  }
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

/** Parse JSON only after bounding both declared and chunked request bodies. */
export async function parseJsonWithinLimit(request: Request, maxBytes: number): Promise<unknown> {
  const declared = declaredContentLength(request);
  if (declared !== null && declared > maxBytes) {
    throw new JsonBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) {
    try {
      return await request.json();
    } catch {
      throw new InvalidJsonBodyError();
    }
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new JsonBodyTooLargeError();
      }
      size += value.byteLength;
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk);
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonBodyError();
  }
}
