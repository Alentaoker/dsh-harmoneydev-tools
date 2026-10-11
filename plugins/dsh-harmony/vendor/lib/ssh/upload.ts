export const SSH_UPLOAD_LIMIT = 100 * 1024 * 1024;
export class SSHUploadTooLargeError extends Error {
  constructor() { super("File exceeds the 100 MB upload limit"); }
}

export async function readSSHUpload(request: Request): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > SSH_UPLOAD_LIMIT) throw new SSHUploadTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SSH_UPLOAD_LIMIT) { await reader.cancel(); throw new SSHUploadTooLargeError(); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
