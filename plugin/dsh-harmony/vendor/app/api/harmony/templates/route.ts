import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { scenarioTemplates, bindScenarioTemplate } from "@/lib/harmony/scenario/templates";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";
export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  return noStoreJson({ templates: scenarioTemplates.map(({ id, version, title, parameters }) => ({ id, version, title, parameters })) });
}
export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try { const body = await parseJsonWithinLimit(request, 32 * 1024) as { id: string; parameters: Record<string, unknown> }; return noStoreJson({ steps: bindScenarioTemplate(body?.id, body?.parameters) }); }
  catch (error) { return harmonyErrorResponse(error); }
}
