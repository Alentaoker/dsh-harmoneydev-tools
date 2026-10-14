import { getHarmonyDeviceManager } from "@/lib/harmony";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { HarmonyError } from "@/lib/harmony/errors";
import { hasJsonContentType } from "@/lib/request-security";
import type { VoiceProfile } from "@/lib/harmony/audio/audio-session";
import type { AppTestPairing } from "@/lib/harmony/audio/app-test-provider";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try { return noStoreJson({ outputs: await getHarmonyDeviceManager().audioOutputs(request.signal) }); }
  catch (error) { return harmonyErrorResponse(error); }
}
export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 32 * 1024) as Record<string, unknown>;
    const manager = getHarmonyDeviceManager();
    if (body?.action === "import" && typeof body.path === "string" && body.path.length < 4096) return noStoreJson({ asset: await manager.importAudio(body.path) });
    if (body?.action === "preview" && typeof body.audioAssetId === "string" && body.output && typeof body.output === "object") return noStoreJson({ result: await manager.previewAudio(body.audioAssetId, body.output as import("@/lib/harmony/audio/acoustic-provider").AudioOutput, request.signal) });
    if (body?.action === "app_test" && typeof body.serial === "string" && typeof body.leaseToken === "string" && typeof body.audioAssetId === "string") return noStoreJson({ result: await manager.appTestAudio({ serial: body.serial, leaseToken: body.leaseToken, audioAssetId: body.audioAssetId, pairing: body.pairing as AppTestPairing, signal: request.signal }) });
    if (body?.action !== "calibrate" || typeof body.serial !== "string" || typeof body.leaseToken !== "string" || typeof body.audioAssetId !== "string" || !body.profile || typeof body.profile !== "object") throw new HarmonyError("INVALID_ARGUMENT", "Calibration requires a selected device, output, local WAV and target conditions");
    return noStoreJson({ result: await manager.voiceInput({ serial: body.serial, leaseToken: body.leaseToken, audioAssetId: body.audioAssetId,
      calibrateProfile: body.profile as Pick<VoiceProfile, "targetAppId" | "output" | "entry" | "ready" | "result" | "mode" | "holdDurationMs">,
      geometryId: typeof body.geometryId === "string" ? body.geometryId : undefined, signal: request.signal,
    }) });
  } catch (error) { return harmonyErrorResponse(error); }
}
