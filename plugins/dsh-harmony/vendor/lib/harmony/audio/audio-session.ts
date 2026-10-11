import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../../atomic-file";
import { HarmonyError } from "../errors";
import { requireValidObservation } from "../observation/quality";
import { findHarmonyNodes, harmonyNodeCenter, resolveHarmonyNode, validateHarmonySelector } from "../selector";
import { deviceFingerprint } from "../input/calibration-store";
import type { HarmonyAutomationBackend, HarmonyDevice, HarmonySnapshot, HarmonyUiSelector } from "../types";
import type { AudioOutput } from "./acoustic-provider";
import type { AudioAsset } from "./audio-assets";

export interface VoiceProfile {
  id: string; fingerprint: string; targetAppId: string; output: AudioOutput;
  entry: HarmonyUiSelector; ready: HarmonyUiSelector; result: HarmonyUiSelector;
  mode: "tap" | "push-to-talk"; holdDurationMs?: number;
  calibratedAt: string; calibrationAssetHash: string; evidence: "device-result-verified";
}
export class VoiceProfileStore {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  save(device: HarmonyDevice, profile: Omit<VoiceProfile, "id" | "fingerprint" | "calibratedAt" | "evidence">) {
    const fingerprint = deviceFingerprint(device);
    const id = createHash("sha256").update(JSON.stringify([fingerprint,profile.targetAppId,profile.output,profile.mode])).digest("hex");
    const record: VoiceProfile = { ...profile, id, fingerprint, calibratedAt: new Date().toISOString(), evidence: "device-result-verified" };
    writePrivateFileAtomicSync(join(this.directory, `${id}.json`), JSON.stringify(record)); return record;
  }
  listIds(device: HarmonyDevice): string[] {
    return readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 500).flatMap(name => {
      try { return [this.get(device, name.slice(0, -5)).id]; } catch { return []; }
    });
  }
  get(device: HarmonyDevice, id: string): VoiceProfile {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid voice profile ID");
    let profile: VoiceProfile | undefined;
    try { profile = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8")); } catch { /* Require calibration. */ }
    if (!profile || profile.fingerprint !== deviceFingerprint(device) || profile.evidence !== "device-result-verified") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Voice route needs calibration on this device and system version", { details: { status: "needs-calibration", dispatchState: "not-sent" } });
    return profile;
  }
}

export interface VoiceInputContext {
  serial: string; backend: HarmonyAutomationBackend; signal: AbortSignal;
  capture(signal: AbortSignal): Promise<HarmonySnapshot>;
  play(signal: AbortSignal): Promise<unknown>;
  /** Revalidate geometry without sending input. Used throughout a held gesture. */
  validateHold?(signal: AbortSignal): Promise<void>;
  beforeDispatch(): void;
  hold?(point: { x: number; y: number }, durationMs: number, signal: AbortSignal): Promise<unknown>;
}
export function validateVoiceProfile(profile: Pick<VoiceProfile, "targetAppId" | "entry" | "ready" | "result" | "mode" | "holdDurationMs">) {
  if (!profile || typeof profile.targetAppId !== "string" || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(profile.targetAppId) || !["tap", "push-to-talk"].includes(profile.mode)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid voice target or mode");
  for (const selector of [profile.entry, profile.ready, profile.result]) validateHarmonySelector(selector);
  if (!profile.result.text || (profile.result.match && profile.result.match !== "exact")) throw new HarmonyError("INVALID_ARGUMENT", "Voice result must specify exact expected transcript text");
  if (profile.mode === "push-to-talk" && (!Number.isInteger(profile.holdDurationMs) || profile.holdDurationMs! < 50 || profile.holdDurationMs! > 15000)) throw new HarmonyError("INVALID_ARGUMENT", "Invalid voice hold duration");
}
/** One scope owns listening, playback and touch release; playback alone never passes. */
export async function runVoiceInput(profile: Pick<VoiceProfile, "targetAppId" | "entry" | "ready" | "result" | "mode" | "holdDurationMs">,
  asset: AudioAsset, context: VoiceInputContext, timeoutMs = 30_000) {
  validateVoiceProfile(profile);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000 || !profile.result.text) throw new HarmonyError("INVALID_ARGUMENT", "Voice input requires an exact expected transcript and a bounded timeout");
  const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort("voice_timeout"), timeoutMs);
  const phases: Array<{ phase: string; timestamp: string }> = [];
  const phase = (value: string) => phases.push({ phase: value, timestamp: new Date().toISOString() });
  let hold: Promise<unknown> | undefined;
  let holdFinished = false;
  let holdStartedAt = 0;
  const tailSilenceMs = 500;
  const observe = async () => {
    context.beforeDispatch(); if (signal.aborted) throw new HarmonyError("COMMAND_ABORTED", "Voice input cancelled");
    const snapshot = await context.capture(signal); requireValidObservation(snapshot);
    if (hold && !holdFinished) await context.validateHold?.(signal);
    if (snapshot.quality?.appId !== profile.targetAppId || !snapshot.quality.windowId) throw new HarmonyError("STALE_SNAPSHOT", "Voice target app/window is not the active observed scope");
    return snapshot;
  };
  const wait = async (selector: HarmonyUiSelector, windowId: string) => {
    for (;;) {
      const snapshot = await observe();
      if (snapshot.quality?.windowId !== windowId) throw new HarmonyError("STALE_SNAPSHOT", "Voice target lost focus");
      if (findHarmonyNodes(snapshot.nodes ?? [], selector).length) return snapshot;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(delay); reject(new HarmonyError("COMMAND_ABORTED", "Voice wait cancelled")); };
        const delay = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 150);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  };
  try {
    const initial = await observe(), windowId = initial.quality!.windowId!;
    if (findHarmonyNodes(initial.nodes ?? [], profile.result).length) throw new HarmonyError("INVALID_ARGUMENT", "Expected transcript already exists; clear the old result before testing");
    const target = resolveHarmonyNode(initial.nodes ?? [], profile.entry); phase("enter-listening");
    context.beforeDispatch();
    if (profile.mode === "push-to-talk") {
      if (!context.hold || !profile.holdDurationMs || profile.holdDurationMs < asset.durationMs + 1000) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Push-to-talk needs a calibrated hold covering readiness, audio and tail silence");
      holdStartedAt = Date.now();
      hold = context.hold(harmonyNodeCenter(target), profile.holdDurationMs, signal).then(value => { holdFinished = true; return value; });
      void hold.catch(() => controller.abort("touch_hold_failed"));
    } else {
      if (!context.backend.semanticAction) throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Voice entry requires a semantic provider");
      await context.backend.semanticAction(context.serial, { action: "tap", selector: profile.entry }, signal);
    }
    await wait(profile.ready, windowId); phase("listening-ready");
    if (holdFinished) throw new HarmonyError("SCENARIO_FAILED", "Touch hold ended before audio started");
    if (hold && profile.holdDurationMs! - (Date.now() - holdStartedAt) < asset.durationMs + tailSilenceMs) {
      throw new HarmonyError("SCENARIO_FAILED", "Listening readiness consumed the calibrated hold budget; audio was not played", { details: { playback: "not-sent" } });
    }
    context.beforeDispatch(); phase("playback-started");
    const playbackController = new AbortController();
    let monitoring = false;
    const monitor = setInterval(() => {
      if (monitoring || signal.aborted) return; monitoring = true;
      void observe().then(snapshot => { if (snapshot.quality?.windowId !== windowId || (hold && holdFinished)) controller.abort("voice_focus_or_hold_lost"); })
        .catch(() => controller.abort("voice_observation_lost")).finally(() => { monitoring = false; });
    }, 250);
    try {
      await context.play(AbortSignal.any([signal, playbackController.signal]));
      phase("playback-completed");
      if (hold) {
        phase("tail-silence");
        const tailStarted = Date.now();
        while (Date.now() - tailStarted < tailSilenceMs) {
          if (signal.aborted || holdFinished) throw new HarmonyError("SCENARIO_FAILED", "Touch hold ended before tail silence completed");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    }
    finally { clearInterval(monitor); playbackController.abort("playback_finished"); }
    if (hold) { await hold; phase("touch-released"); }
    const result = await wait({ ...profile.result, match: "exact" }, windowId); phase("recognition-verified");
    return { status: "passed" as const, provider: "acoustic" as const, audioHash: asset.hash, phases,
      verification: "device-transcript" as const, resultHash: createHash("sha256").update(JSON.stringify(findHarmonyNodes(result.nodes ?? [], profile.result).map(node => node.text))).digest("hex"), cleanup: "complete" as const };
  } catch (error) {
    controller.abort("voice_failed");
    if (hold) try { await hold; } catch (releaseError) { if (releaseError instanceof HarmonyError && releaseError.details?.cleanup === "uncertain") throw releaseError; }
    throw error;
  } finally { clearTimeout(timer); controller.abort("voice_complete"); }
}
