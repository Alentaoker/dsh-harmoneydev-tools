import { getHarmonyDeviceManager } from "@/lib/harmony";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { validateAction } from "@/lib/harmony/contracts/actions";
import { HarmonyError } from "@/lib/harmony/errors";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 16 * 1024) as Record<string, unknown>;
    if (!body || typeof body.serial !== "string" || body.serial.length > 256) throw new HarmonyError("INVALID_ARGUMENT", "Device serial required");
    const manager = getHarmonyDeviceManager();
    if (body.action === "confirm_cleanup") {
      if (body.released !== true || body.recordingStopped !== true) throw new HarmonyError("INVALID_ARGUMENT", "Confirm only after physically checking that keys, touch and recording have stopped");
      return noStoreJson(await manager.confirmCleanup(body.serial, request.signal));
    }
    if (body.action === "confirm") {
      if (typeof body.id !== "string" || body.released !== true || body.observedExpectedBehavior !== true) throw new HarmonyError("INVALID_ARGUMENT", "Confirm only after observing the expected behavior and physical release");
      const assistant = body.assistant as Parameters<typeof manager.confirmInputCalibration>[2];
      if (assistant && (typeof assistant.appId !== "string" || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(assistant.appId))) throw new HarmonyError("INVALID_ARGUMENT", "Invalid assistant application");
      return noStoreJson({ calibration: await manager.confirmInputCalibration(body.serial, body.id, assistant) });
    }
    validateAction(body, "direct");
    if (typeof body.leaseToken !== "string") throw new HarmonyError("LEASE_REQUIRED", "Manual device control is required");
    const common = { serial: body.serial, leaseToken: body.leaseToken, durationMs: Number(body.durationMs), calibrate: true, signal: request.signal };
    if (body.action === "key_hold") return noStoreJson({ result: await manager.keyHold({ ...common, key: body.key as "power" | "volume_up" | "volume_down" }) });
    if (body.action === "touch_hold") return noStoreJson({ result: await manager.touchHold({ ...common, x: Number(body.x), y: Number(body.y), geometryId: String(body.geometryId), coordinateSpace: body.coordinateSpace === "frame" ? "frame" : "native" }) });
    throw new HarmonyError("INVALID_ARGUMENT", "Unsupported calibration action");
  } catch (error) { return harmonyErrorResponse(error); }
}
