import { noStoreJson, requireHarmonyDesktopAccess } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * Narrow bootstrap exception: it exposes only the active profile so the
 * desktop renderer can explain why the device routes are unavailable. It is
 * still same-origin and per-launch desktop-token authenticated.
 */
export async function GET(request: Request) {
  const denied = requireHarmonyDesktopAccess(request);
  if (denied) return denied;
  return noStoreJson({
    profile: process.env.PIORA_RUNTIME_PROFILE === "device-control" ? "device-control" : "normal",
  });
}
