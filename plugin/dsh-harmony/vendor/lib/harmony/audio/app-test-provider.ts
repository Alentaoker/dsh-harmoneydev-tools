import { createHash } from "node:crypto";
import { HarmonyError } from "../errors";
import { parsePcmWav } from "./audio-assets";
export interface AppTestPairing { runId: string; deviceInstance: string; token: string; expiresAt: number }
export function appTestPacket(wav: Buffer, pairing: AppTestPairing, ownerId: string, now = Date.now()) {
  const uuid = /^[a-f0-9-]{36}$/i;
  if (!pairing || pairing.runId !== ownerId || !uuid.test(pairing.deviceInstance) || !uuid.test(pairing.token) || !Number.isSafeInteger(pairing.expiresAt) || pairing.expiresAt <= now || pairing.expiresAt > now + 120_000) throw new HarmonyError("INVALID_ARGUMENT", "Debug pairing must be unexpired and bound to this control owner");
  const parsed = parsePcmWav(wav);
  if (parsed.sampleRate !== 16000 || parsed.channels !== 1 || parsed.pcmBytes > 8000) throw new HarmonyError("INVALID_ARGUMENT", "Debug bridge accepts 16 kHz mono PCM16 samples of 50–250 ms");
  const pcm = wav.subarray(parsed.pcmOffset, parsed.pcmOffset + parsed.pcmBytes);
  return { packet: Buffer.from(JSON.stringify({ ...pairing, sampleRate: 16000, channels: 1, pcmBase64: pcm.toString("base64") })).toString("base64"),
    expected: `app-test:${createHash("sha256").update(pcm).digest("hex")}` };
}
