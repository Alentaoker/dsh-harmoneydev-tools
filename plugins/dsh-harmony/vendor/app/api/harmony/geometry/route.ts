import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess, requiredQuery } from "../_shared";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const space = requiredQuery(request, "space");
    if (space !== "video" && space !== "screenshot") throw new HarmonyError("INVALID_ARGUMENT", "Unknown frame space");
    return noStoreJson({ geometry: await getHarmonyDeviceManager().getFrameGeometry(requiredQuery(request, "serial"), space, request.signal) });
  } catch (error) { return harmonyErrorResponse(error); }
}
