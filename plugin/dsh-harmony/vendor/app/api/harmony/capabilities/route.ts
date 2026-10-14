import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const serial = new URL(request.url).searchParams.get("serial");
    if (!serial) throw new HarmonyError("INVALID_ARGUMENT", "serial is required");
    return noStoreJson({ report: await getHarmonyDeviceManager().doctor(serial, request.signal, new URL(request.url).searchParams.get("reprobe") === "1") });
  } catch (error) { return harmonyErrorResponse(error); }
}
