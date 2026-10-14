import { HarmonyDeviceManager, type HarmonyDeviceManagerOptions } from "./device-manager";

export * from "./errors";
export * from "./types";
export * from "./runtime";
export * from "./command-runner";
export * from "./hdc-backend";
export * from "./hypium-backend";
export * from "./hybrid-backend";
export * from "./selector";
export * from "./scenario-executor";
export * from "./device-label";
export * from "./vision";
export * from "./screenshot-stability";
export * from "./artifacts";
export { HarmonyDeviceManager, type HarmonyDeviceManagerOptions } from "./device-manager";

declare global {
  var __pioraHarmonyDeviceManager: HarmonyDeviceManager | undefined;
}

export function createHarmonyDeviceManager(options: HarmonyDeviceManagerOptions = {}): HarmonyDeviceManager {
  return new HarmonyDeviceManager(options);
}

/** Shared physical-device coordinator; survives Next.js development hot reloads. */
export function getHarmonyDeviceManager(options: HarmonyDeviceManagerOptions = {}): HarmonyDeviceManager {
  if (!globalThis.__pioraHarmonyDeviceManager) {
    globalThis.__pioraHarmonyDeviceManager = createHarmonyDeviceManager(options);
  }
  return globalThis.__pioraHarmonyDeviceManager;
}

/** Test helper only. Production callers should keep using getHarmonyDeviceManager(). */
export async function resetHarmonyDeviceManagerForTests(): Promise<void> {
  const manager = globalThis.__pioraHarmonyDeviceManager;
  globalThis.__pioraHarmonyDeviceManager = undefined;
  await manager?.dispose();
}
