import { getHarmonyDeviceManager } from "@/lib/harmony";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";
export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    return noStoreJson({ applications: await getHarmonyDeviceManager().applications(params.get("serial") ?? "", params.get("query") ?? "", params.get("bundleName") ?? undefined, request.signal) });
  } catch (error) { return harmonyErrorResponse(error); }
}
