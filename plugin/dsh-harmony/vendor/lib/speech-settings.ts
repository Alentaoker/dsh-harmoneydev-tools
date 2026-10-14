import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getRuntimeAgentDataDirectory } from "./runtime-home";

interface StoredSpeechSettings {
  schema: 1;
  enabled: boolean;
  packDirectory?: string;
}

export interface SpeechSettings {
  enabled: boolean;
  packDirectory: string;
  customPackDirectory: boolean;
}

function defaultPackDirectory(): string {
  const explicit = process.env.PIORA_SPEECH_PACKS_DIR?.trim();
  if (explicit) return resolve(explicit);
  const desktopData = process.env.PIORA_DESKTOP_DATA_DIR?.trim();
  if (desktopData) return join(resolve(desktopData), "speech-packs");
  return join(getRuntimeAgentDataDirectory(), "piora", "speech-packs");
}

export function speechSettingsPath(): string {
  const desktopData = process.env.PIORA_DESKTOP_DATA_DIR?.trim();
  if (desktopData) return join(resolve(desktopData), "speech-settings.json");
  return join(getRuntimeAgentDataDirectory(), "piora", "speech-settings.json");
}

export async function readSpeechSettings(): Promise<SpeechSettings> {
  let stored: StoredSpeechSettings | null = null;
  try {
    const parsed = JSON.parse(await readFile(speechSettingsPath(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = parsed as Partial<StoredSpeechSettings>;
      if (candidate.schema === 1 && typeof candidate.enabled === "boolean") {
        stored = {
          schema: 1,
          enabled: candidate.enabled,
          ...(typeof candidate.packDirectory === "string" && isAbsolute(candidate.packDirectory)
            ? { packDirectory: resolve(candidate.packDirectory) }
            : {}),
        };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return {
    enabled: stored?.enabled ?? false,
    packDirectory: stored?.packDirectory ?? defaultPackDirectory(),
    customPackDirectory: Boolean(stored?.packDirectory),
  };
}

export async function writeSpeechSettings(input: {
  enabled: boolean;
  packDirectory?: string | null;
}): Promise<SpeechSettings> {
  const requestedDirectory = input.packDirectory?.trim();
  if (requestedDirectory && !isAbsolute(requestedDirectory)) {
    throw new Error("Speech pack directory must be an absolute path");
  }
  const stored: StoredSpeechSettings = {
    schema: 1,
    enabled: Boolean(input.enabled),
    ...(requestedDirectory ? { packDirectory: resolve(requestedDirectory) } : {}),
  };
  const path = speechSettingsPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return {
    enabled: stored.enabled,
    packDirectory: stored.packDirectory ?? defaultPackDirectory(),
    customPackDirectory: Boolean(stored.packDirectory),
  };
}
