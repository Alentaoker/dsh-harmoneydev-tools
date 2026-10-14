import { getHarmonyDeviceManager } from "@/lib/harmony";
import { harmonyErrorResponse, noStoreJson, publicManagerState, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const serial = new URL(request.url).searchParams.get("serial")?.trim() || undefined;
    return noStoreJson({ state: publicManagerState(getHarmonyDeviceManager().getState(serial)) });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}
