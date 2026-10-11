import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildHarmonyPreview, type HarmonyBuildRuntimeOverride, type HarmonyBuildSelection } from "./build-adapter";
import { exportDesignReferences } from "./asset-export";
import { createDesignSourceAdapter } from "./source-factory";
import { getDesignImportStore } from "./import-store";
import { DesignToHarmonyError } from "./errors";
import { stableDesignHash } from "./stable-json";
import { compareDesignScreenshots } from "./visual-diff";
import { analyzeHarmonyProject } from "./project-analyzer";
import { getHarmonyDeviceManager } from "../harmony";
import { compareHarmonyScreenshotSamples, sampleHarmonyScreenshot } from "../harmony/screenshot-stability";
import type { HarmonyDeviceManager } from "../harmony/device-manager";
import type { HarmonySnapshot } from "../harmony/types";
import type {
  DesignAnalysisRun,
  DesignDeviceValidation,
  DesignValidationResult,
  DesignVisualComparison,
  GeneratedArtifactManifest,
} from "./types";

const DEVICE_WAIT_TIMEOUT_MS = 12_000;
const DEVICE_SAMPLE_INTERVAL_MS = 450;

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
  await new Promise<void>((resolveDelay, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Cancelled", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    timer.unref?.();
  });
}

async function stableDeviceSnapshot(manager: HarmonyDeviceManager, serial: string, leaseToken: string, signal?: AbortSignal): Promise<{ snapshot: HarmonySnapshot; stable: boolean }> {
  const started = Date.now();
  let previous;
  let stableSamples = 0;
  let latest: HarmonySnapshot | undefined;
  while (Date.now() - started < DEVICE_WAIT_TIMEOUT_MS) {
    latest = await manager.snapshot({ serial, leaseToken, includeTree: true, includeScreenshot: true, signal });
    if (!latest.screenshot) throw new DesignToHarmonyError("DEVICE_VALIDATION_FAILED", "Harmony screenshot capture is unavailable", { status: 409, retryable: true, stage: "device" });
    const current = sampleHarmonyScreenshot(latest.screenshot);
    if (previous) {
      const difference = compareHarmonyScreenshotSamples(previous, current, 18);
      stableSamples = difference.changedRatio <= 0.003 && difference.meanDelta <= 3 ? stableSamples + 1 : 0;
      if (stableSamples >= 2) return { snapshot: latest, stable: true };
    }
    previous = current;
    await delay(DEVICE_SAMPLE_INTERVAL_MS, signal);
  }
  if (!latest) throw new DesignToHarmonyError("DEVICE_VALIDATION_FAILED", "Harmony device did not return a screenshot", { status: 409, retryable: true, stage: "device" });
  return { snapshot: latest, stable: false };
}

async function validateOnDevice(input: {
  manager: HarmonyDeviceManager;
  run: DesignAnalysisRun;
  hapPath: string;
  serial?: string;
  signal?: AbortSignal;
  outputRoot: string;
}): Promise<{ device: DesignDeviceValidation; snapshot?: HarmonySnapshot; actualPath?: string }> {
  const inventory = analyzeHarmonyProject(input.run.projectRoot);
  const online = (await input.manager.listDevices(input.signal)).filter((device) => device.state === "online");
  const device = input.serial ? online.find((candidate) => candidate.serial === input.serial) : online.length === 1 ? online[0] : undefined;
  if (!device) {
    return { device: { status: "unavailable", serial: input.serial, installed: false, launched: false, stable: false, message: online.length > 1 ? "Select one connected Harmony device." : "No online Harmony device is connected." } };
  }
  const bundleName = inventory.bundleName;
  const moduleEntry = inventory.modules.find((item) => item.name === inventory.selectedModule) ?? inventory.modules[0];
  const abilityName = moduleEntry?.abilityName ?? moduleEntry?.mainElement;
  if (!bundleName) return { device: { status: "unavailable", serial: device.serial, installed: false, launched: false, stable: false, message: "AppScope/app.json5 does not declare a bundleName." } };
  const ownerId = `design-validation:${input.run.id}`;
  let lease;
  try {
    lease = await input.manager.acquireLease({ serial: device.serial, owner: { kind: "agent", id: ownerId }, ttlMs: 2 * 60_000, signal: input.signal });
    await input.manager.installPackage({ serial: device.serial, leaseToken: lease.token, hapPath: input.hapPath, replace: true, signal: input.signal });
    await input.manager.launchApp({ serial: device.serial, leaseToken: lease.token, bundleName, ...(abilityName ? { abilityName } : {}), signal: input.signal });
    const stable = await stableDeviceSnapshot(input.manager, device.serial, lease.token, input.signal);
    let actualPath: string | undefined;
    if (stable.snapshot.screenshot) {
      actualPath = join(resolve(input.outputRoot), "device.png");
      mkdirSync(dirname(actualPath), { recursive: true, mode: 0o700 });
      writeFileSync(actualPath, stable.snapshot.screenshot.data, { mode: 0o600 });
    }
    return {
      device: { status: stable.stable ? "passed" : "failed", serial: device.serial, bundleName, ...(abilityName ? { abilityName } : {}), installed: true, launched: true, stable: stable.stable, ...(!stable.stable ? { message: "The screen did not settle before the visual timeout." } : {}) },
      snapshot: stable.snapshot,
      ...(actualPath ? { actualPath } : {}),
    };
  } catch (error) {
    if (input.signal?.aborted) return { device: { status: "cancelled", serial: device.serial, bundleName, ...(abilityName ? { abilityName } : {}), installed: false, launched: false, stable: false, message: "Device validation cancelled." } };
    return { device: { status: "failed", serial: device.serial, bundleName, ...(abilityName ? { abilityName } : {}), installed: false, launched: false, stable: false, message: error instanceof Error ? error.message : "Harmony device validation failed." } };
  } finally {
    if (lease) input.manager.releaseLease(lease.token);
    input.manager.releaseOwner(ownerId);
  }
}

export async function validateDesignRun(input: {
  run: DesignAnalysisRun;
  preview: GeneratedArtifactManifest;
  mode?: "preview" | "applied";
  selection?: HarmonyBuildSelection;
  runtime?: HarmonyBuildRuntimeOverride;
  withDevice?: boolean;
  serial?: string;
  signal?: AbortSignal;
  manager?: HarmonyDeviceManager;
  dataRoot?: string;
  onProgress?: (stage: string, message: string, progress: number) => void;
}): Promise<DesignValidationResult> {
  const startedAt = new Date().toISOString();
  input.onProgress?.("build", "Compiling the isolated Harmony preview", 0.12);
  const build = await buildHarmonyPreview({
    run: input.run,
    preview: input.preview,
    mode: input.mode ?? "preview",
    selection: input.selection,
    runtime: input.runtime,
    signal: input.signal,
    dataRoot: input.dataRoot,
  });
  let device: DesignDeviceValidation | undefined;
  let visual: DesignVisualComparison | undefined;
  if (build.status === "passed" && build.hapPath && input.withDevice) {
    input.onProgress?.("device", "Installing and launching the generated HAP", 0.62);
    const outputRoot = dirname(build.hapPath);
    const deviceResult = await validateOnDevice({ manager: input.manager ?? getHarmonyDeviceManager(), run: input.run, hapPath: build.hapPath, serial: input.serial, signal: input.signal, outputRoot });
    device = deviceResult.device;
    const designImport = getDesignImportStore().get(input.run.importId);
    if (deviceResult.snapshot?.screenshot && designImport) {
      input.onProgress?.("visual", "Comparing the device screen with the design reference", 0.84);
      const adapter = createDesignSourceAdapter(designImport.source);
      const references = await exportDesignReferences({ adapter, source: designImport.source, sourceVersion: input.run.sourceVersion, nodeIds: input.run.targetNodeIds.slice(0, 1), outputRoot: join(outputRoot, "references"), signal: input.signal });
      const reference = references[0];
      if (reference?.data && reference.path && deviceResult.actualPath) {
        visual = await compareDesignScreenshots({
          reference: reference.data,
          actual: deviceResult.snapshot.screenshot.data,
          outputPath: join(outputRoot, "visual-diff.png"),
          alignedReferencePath: join(outputRoot, "visual-reference.png"),
          alignedActualPath: join(outputRoot, "visual-device.png"),
          nodes: deviceResult.snapshot.nodes,
          sourceNodeIds: input.run.targetNodeIds,
        });
      } else {
        visual = { status: "unavailable", threshold: 24, regions: [], ...(reference?.path ? { referencePath: reference.path } : {}), ...(deviceResult.actualPath ? { actualPath: deviceResult.actualPath } : {}), message: reference?.error ?? "Design reference is unavailable." };
      }
    }
  }
  const completedAt = new Date().toISOString();
  const base = { mode: input.mode ?? "preview", startedAt, completedAt, build, ...(device ? { device } : {}), ...(visual ? { visual } : {}) };
  return { ...base, id: `validation_${stableDesignHash(base).slice(0, 20)}` };
}
