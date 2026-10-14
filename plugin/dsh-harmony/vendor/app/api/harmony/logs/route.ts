import { getHarmonyDeviceManager, HarmonyError, type HarmonyLogLevel } from "@/lib/harmony";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess, requiredQuery } from "../_shared";

export const dynamic = "force-dynamic";

const LOG_LEVELS = new Set<HarmonyLogLevel>(["debug", "info", "warn", "error", "fatal"]);

function optionalInteger(value: string | null, name: string, minimum: number, maximum: number): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HarmonyError("INVALID_ARGUMENT", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const serial = requiredQuery(request, "serial");
    const action = url.searchParams.get("action") ?? "logs";
    const manager = getHarmonyDeviceManager();
    if (action === "processes") {
      return noStoreJson({ processes: await manager.listProcesses(serial, request.signal) });
    }
    if (action !== "logs") throw new HarmonyError("INVALID_ARGUMENT", "Unsupported Harmony log action");
    const rawLevel = url.searchParams.get("level") as HarmonyLogLevel | null;
    const level = rawLevel && LOG_LEVELS.has(rawLevel) ? rawLevel as Exclude<HarmonyLogLevel, "unknown"> : undefined;
    if (rawLevel && !level) throw new HarmonyError("INVALID_ARGUMENT", "Invalid Harmony log level");
    const query = (url.searchParams.get("query") ?? "").trim().slice(0, 256);
    const pid = optionalInteger(url.searchParams.get("pid"), "pid", 1, 2_147_483_647);
    const entries = await manager.readLogs({
      serial,
      ...(pid !== undefined ? { pid } : {}),
      ...(level ? { level } : {}),
      ...(query ? { query } : {}),
      limit: optionalInteger(url.searchParams.get("limit"), "limit", 1, 2_000) ?? 400,
      signal: request.signal,
    });
    return noStoreJson({ entries, capturedAt: new Date().toISOString() });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}
