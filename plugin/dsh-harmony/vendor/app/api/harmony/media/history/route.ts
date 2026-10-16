import { getHarmonyDeviceManager } from "@/lib/harmony";
import { listHarmonyMediaHistory } from "@/lib/harmony/media-history";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const serial = params.get("serial") ?? "";
    const scope = params.get("scope") === "legacy" ? "legacy" : "manual";
    return noStoreJson(await listHarmonyMediaHistory(getHarmonyDeviceManager().getConfig(), serial, scope));
  } catch (error) { return harmonyErrorResponse(error); }
}
