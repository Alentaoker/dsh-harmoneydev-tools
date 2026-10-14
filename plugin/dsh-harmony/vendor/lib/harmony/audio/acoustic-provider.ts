import { spawn } from "node:child_process";
import { join } from "node:path";
import { harmonyRuntimeAsset } from "../runtime/asset-path";
import { HarmonyError } from "../errors";
import { acquireDeviceLock } from "../runtime/device-lock";

export interface AudioOutput { id: number; name: string; provider: "windows-waveout" }
export class WindowsAcousticProvider {
  private script = harmonyRuntimeAsset("lib", "harmony", "audio", "acoustic-provider.ps1");
  private async run(args: string[], signal?: AbortSignal): Promise<string> {
    if (process.platform !== "win32") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The selected acoustic provider requires Windows; no default audio route will be substituted");
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Audio cancelled before playback", { details: { dispatchState: "not-sent" } });
    return await new Promise((resolve, reject) => {
      const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.script, ...args], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", failure: HarmonyError | undefined, settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(output);
      };
      const stop = (reason: HarmonyError) => {
        if (failure) return; failure = reason; child.kill();
        killTimer = setTimeout(() => finish(new HarmonyError(reason.code, "Audio process termination is uncertain; output remains quarantined", { details: { cleanup: "uncertain" } })), 2000);
      };
      const abort = () => stop(new HarmonyError("COMMAND_ABORTED", "Audio playback cancelled", { details: { cleanup: "complete" } }));
      const timer = setTimeout(() => stop(new HarmonyError("COMMAND_TIMEOUT", "Audio playback timed out")), 45_000);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 64 * 1024) stop(new HarmonyError("COMMAND_OUTPUT_LIMIT", "Audio output exceeded limit")); });
      // Device names and native errors can contain user text; never echo arbitrary stderr.
      child.stderr.resume();
      child.once("error", () => finish(new HarmonyError("CAPABILITY_UNAVAILABLE", "Unable to launch the acoustic output helper")));
      child.once("close", code => finish(failure ?? (code === 0 ? undefined : new HarmonyError("COMMAND_FAILED", "The selected audio output failed; check its connection and calibration"))));
    });
  }
  async outputs(signal?: AbortSignal): Promise<AudioOutput[]> {
    const list = JSON.parse((await this.run(["-Action", "list"], signal)).replace(/^\uFEFF/, ""));
    if (!Array.isArray(list) || list.length > 128 || list.some(value => !Number.isInteger(value.id) || typeof value.name !== "string")) throw new HarmonyError("INVALID_RESPONSE", "Invalid output device list");
    return list;
  }
  async play(output: AudioOutput, path: string, signal?: AbortSignal) {
    if (!Number.isInteger(output.id) || output.id < 0 || output.id > 127 || output.provider !== "windows-waveout" || !output.name || output.name.length > 256) throw new HarmonyError("INVALID_ARGUMENT", "Choose a valid explicit audio output");
    // Shared room lock prevents cross-talk even if two callers select different speakers.
    const lock = acquireDeviceLock("acoustic:shared-room");
    let uncertain = false;
    const startedAt = new Date().toISOString();
    try {
      await this.run(["-Action", "play", "-DeviceId", String(output.id), "-ExpectedName", output.name, "-AssetPath", path], signal);
      return { provider: output.provider, startedAt, completedAt: new Date().toISOString(), playback: "completed" as const, recognition: "not-verified" as const, cleanup: "complete" as const };
    } catch (error) { uncertain = error instanceof HarmonyError && error.details?.cleanup === "uncertain"; throw error; }
    finally { if (!uncertain) lock.release(); }
  }
}
