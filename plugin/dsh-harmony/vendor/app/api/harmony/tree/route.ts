import { getHarmonyDeviceManager } from "@/lib/harmony";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess, requiredQuery } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const snapshot = await getHarmonyDeviceManager().snapshot({
      serial: requiredQuery(request, "serial"),
      leaseToken: url.searchParams.get("leaseToken")?.trim() || undefined,
      includeTree: true,
      includeScreenshot: false,
      signal: request.signal,
    });
    return noStoreJson({ snapshot: {
      serial: snapshot.serial,
      generation: snapshot.generation,
      revision: snapshot.revision,
      capturedAt: snapshot.capturedAt,
      tree: snapshot.tree,
      nodes: snapshot.nodes,
    } });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}
