import { getHarmonyDeviceManager } from "@/lib/harmony";
import { harmonyErrorResponse, noStoreJson, publicManagerState, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const manager = getHarmonyDeviceManager();
    const devices = await manager.listDevices(request.signal);
    return noStoreJson({ devices, state: publicManagerState(manager.getState()) });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}
