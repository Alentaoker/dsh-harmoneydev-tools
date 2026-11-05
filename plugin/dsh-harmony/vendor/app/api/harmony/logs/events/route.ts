import { getHarmonyDeviceManager } from "@/lib/harmony";
import { createLogEventStream } from "../../../../../lib/harmony/log-event-stream.mjs";
import { harmonyErrorResponse, requireHarmonyAccess, requiredQuery } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  let serial: string;
  try { serial = requiredQuery(request, "serial"); } catch (error) { return harmonyErrorResponse(error); }
  const stream = createLogEventStream(
    (onEntries, signal) => getHarmonyDeviceManager().streamLogs(serial, onEntries, signal),
    request.signal,
  );
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-cache, no-store", Connection: "keep-alive", "X-Accel-Buffering": "no",
  } });
}
