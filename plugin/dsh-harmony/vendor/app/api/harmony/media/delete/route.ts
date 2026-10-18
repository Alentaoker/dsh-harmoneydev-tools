import { getHarmonyDeviceManager } from "@/lib/harmony";
import { deleteHarmonyMedia } from "@/lib/harmony/media-history";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 256 * 1024) as any;
    return noStoreJson(await deleteHarmonyMedia(getHarmonyDeviceManager().getConfig(), body?.serial, body?.items, body?.scope));
  } catch (error) { return harmonyErrorResponse(error); }
}
