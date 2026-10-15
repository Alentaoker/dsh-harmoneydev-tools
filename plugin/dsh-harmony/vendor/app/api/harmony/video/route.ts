import { getHarmonyDeviceManager } from "@/lib/harmony";
import { HarmonyError } from "@/lib/harmony/errors";
import { parseJsonWithinLimit } from '@/lib/bounded-json';
import { hasJsonContentType } from '@/lib/request-security';
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess, requiredQuery } from "../_shared";
import type { NativeVideoRecovery } from '@/lib/harmony/native-video-conflict';

export const dynamic = "force-dynamic";

export async function POST(request:Request) {
  const denied=requireHarmonyAccess(request);if(denied)return denied;
  if(!hasJsonContentType(request))return noStoreJson({error:'Content-Type must be application/json'},{status:415});
  try {
    const body=await parseJsonWithinLimit(request,2048) as Record<string,unknown>;
    if(body?.action!=='release-conflict'||typeof body.serial!=='string'||typeof body.leaseToken!=='string')throw new HarmonyError('INVALID_ARGUMENT','Invalid video recovery request');
    const result=await getHarmonyDeviceManager().releaseVideoConflict({serial:body.serial,leaseToken:body.leaseToken,
      confirmed:body.confirmed===true,expected:body.expected as NativeVideoRecovery,signal:request.signal});
    return noStoreJson({result});
  }catch(error){return harmonyErrorResponse(error);}
}

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request);
  if (denied) return denied;
  try {
    const serial = requiredQuery(request, "serial");
    const manager = getHarmonyDeviceManager();
    const connection = await manager.openVideoStream({ serial, signal: request.signal });
    const device = manager.getState().devices.find((candidate) => candidate.serial === serial);
    if (!device) {
      await connection.close();
      throw new HarmonyError("DEVICE_NOT_FOUND", "The selected Harmony device is not connected");
    }
    return new Response(connection.stream, {
      headers: {
        "Content-Type": "application/vnd.piora.harmony-stream",
        "Cache-Control": "private, no-store, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "X-Harmony-Generation": String(device.generation),
      },
    });
  } catch (error) {
    return harmonyErrorResponse(error);
  }
}
