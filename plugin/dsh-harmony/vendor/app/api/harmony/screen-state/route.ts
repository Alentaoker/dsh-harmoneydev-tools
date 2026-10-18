import { getHarmonyDeviceManager } from "@/lib/harmony";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess, requiredQuery } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * Passive lock/awake probe used by the live-view phase machine. The response
 * never wakes or unlocks the phone; a device that cannot answer returns an
 * explicit error so the panel is not told an unknown state is "unlocked".
 */
export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const serial = requiredQuery(request, "serial");
    const state = await getHarmonyDeviceManager().screenState({ serial, signal: request.signal });
    return noStoreJson(state);
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}
