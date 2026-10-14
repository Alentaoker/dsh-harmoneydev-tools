import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

type ImageCapableModel = { provider: string; id: string; input?: readonly ("text" | "image")[] };
type CapabilityConfig = { imageInput?: Record<string, boolean> };

const configPath = (baseDir = getAgentDir()) => join(baseDir, "piora", "model-capabilities.json");
export const modelCapabilityKey = (provider: string, id: string) => `${provider}/${id}`;

function readConfig(baseDir?: string): CapabilityConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(baseDir), "utf8")) as CapabilityConfig;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function getConfiguredImageInput(provider: string, id: string, baseDir?: string): boolean | undefined {
  return readConfig(baseDir).imageInput?.[modelCapabilityKey(provider, id)];
}

export function hasConfiguredImageInput(provider: string, id: string, baseDir?: string): boolean {
  return getConfiguredImageInput(provider, id, baseDir) === true;
}

export function modelSupportsImages(model: ImageCapableModel | undefined, baseDir?: string): boolean {
  if (!model) return false;
  const configured = getConfiguredImageInput(model.provider, model.id, baseDir);
  if (configured !== undefined) return configured;
  return model.input?.includes("image") === true;
}

export function applyConfiguredImageInput<T extends ImageCapableModel>(model: T, baseDir?: string): T {
  const configured = getConfiguredImageInput(model.provider, model.id, baseDir);
  if (configured === false && model.input?.includes("image")) {
    return { ...model, input: model.input.filter((entry) => entry !== "image") } as T;
  }
  if (configured === true && !model.input?.includes("image")) {
    return { ...model, input: [...(model.input ?? ["text"]), "image"] } as T;
  }
  return model;
}

export function writeConfiguredImageInput(provider: string, id: string, enabled: boolean, baseDir?: string): void {
  const config = readConfig(baseDir);
  const imageInput = { ...(config.imageInput ?? {}) };
  // Persist both directions: an explicit false must keep overriding a catalog
  // that declares image input, so it is stored instead of deleted.
  imageInput[modelCapabilityKey(provider, id)] = enabled;
  const path = configPath(baseDir);
  mkdirSync(join(path, ".."), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ imageInput }, null, 2)}\n`);
}
