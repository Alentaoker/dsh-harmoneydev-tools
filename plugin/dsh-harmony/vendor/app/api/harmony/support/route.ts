import { getHarmonyDeviceManager } from "@/lib/harmony";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";
export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request,4096) as Record<string,unknown>;
    return noStoreJson({ artifact: await getHarmonyDeviceManager().supportBundle({ serial: typeof body.serial === "string" ? body.serial : undefined, includeTree: body.includeTree === true, includeScreenshot: body.includeScreenshot === true, signal: request.signal }) });
  } catch (error) { return harmonyErrorResponse(error); }
}
