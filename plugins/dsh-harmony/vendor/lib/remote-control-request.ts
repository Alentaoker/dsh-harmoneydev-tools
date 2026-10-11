import { hasJsonContentType } from "./request-security";

export const REMOTE_JSON_LIMIT_BYTES = 256 * 1024;

export async function readRemoteJson(request: Request): Promise<Record<string, unknown>> {
  if (!hasJsonContentType(request)) throw new Error("JSON content type is required.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > REMOTE_JSON_LIMIT_BYTES) throw new Error("Request body is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > REMOTE_JSON_LIMIT_BYTES) throw new Error("Request body is too large.");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Request body is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}
export function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || value.length > 512) throw new Error("Idempotency-Key header is required.");
  return value;
}
