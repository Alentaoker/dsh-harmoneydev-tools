import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../../atomic-file";
import { HarmonyError } from "../errors";
import type { HarmonyDevice } from "../types";
import type { PhysicalKey } from "./key-catalog";
import type { HarmonyUiSelector } from "../types";

export interface InputCalibration {
  id: string; fingerprint: string; kind: "key" | "touch"; key?: PhysicalKey;
  provider: "uinput-sequence"; durationMs: number; cleanup: "complete";
  createdAt: string; confirmedAt?: string; evidence: "manual-confirmed" | "awaiting-confirmation";
  assistant?: { appId: string; selector: HarmonyUiSelector };
}
export const deviceFingerprint = (device: HarmonyDevice) => createHash("sha256").update(JSON.stringify([device.serial, device.model, device.osVersion, device.apiVersion, device.uitestVersion])).digest("hex");
export class InputCalibrationStore {
  private readonly pending = new Map<string, InputCalibration>();
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  record(device: HarmonyDevice, kind: "key" | "touch", durationMs: number, key?: PhysicalKey): InputCalibration {
    const item: InputCalibration = { id: randomUUID(), fingerprint: deviceFingerprint(device), kind, key, provider: "uinput-sequence", durationMs, cleanup: "complete", createdAt: new Date().toISOString(), evidence: "awaiting-confirmation" };
    this.pending.set(item.id, item); return item;
  }
  confirm(device: HarmonyDevice, id: string, assistant?: InputCalibration["assistant"]): InputCalibration {
    const item = this.pending.get(id);
    if (!item || item.fingerprint !== deviceFingerprint(device) || Date.now() - Date.parse(item.createdAt) > 5 * 60_000) throw new HarmonyError("INVALID_ARGUMENT", "Calibration expired or belongs to another device");
    item.evidence = "manual-confirmed"; item.confirmedAt = new Date().toISOString();
    if (assistant) { if (item.key !== "power") throw new HarmonyError("INVALID_ARGUMENT", "Assistant profiles require power-key calibration"); item.assistant = assistant; }
    writePrivateFileAtomicSync(join(this.directory, `${item.fingerprint}-${item.kind}-${item.key ?? "point"}.json`), JSON.stringify(item));
    this.pending.delete(id); return { ...item };
  }
  assistant(device: HarmonyDevice, id: string): InputCalibration {
    let item: InputCalibration | undefined;
    try { item = JSON.parse(readFileSync(join(this.directory, `${deviceFingerprint(device)}-key-power.json`), "utf8")); } catch { /* Require calibration. */ }
    if (!item || item.id !== id || !item.assistant || item.evidence !== "manual-confirmed" || item.fingerprint !== deviceFingerprint(device)) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This device has no matching verified assistant profile", { details: { status: "needs-calibration", dispatchState: "not-sent" } });
    return item;
  }
  require(device: HarmonyDevice, kind: "key" | "touch", durationMs: number, key?: PhysicalKey): InputCalibration {
    let item: InputCalibration | undefined;
    try { item = JSON.parse(readFileSync(join(this.directory, `${deviceFingerprint(device)}-${kind}-${key ?? "point"}.json`), "utf8")); } catch { /* Fail closed. */ }
    if (!item || item.evidence !== "manual-confirmed" || item.fingerprint !== deviceFingerprint(device) || item.durationMs !== durationMs) {
      throw new HarmonyError("CAPABILITY_UNAVAILABLE", "This device, input and exact hold duration need visible release calibration", { details: { dispatchState: "not-sent", status: "needs-calibration" } });
    }
    return item;
  }
}
