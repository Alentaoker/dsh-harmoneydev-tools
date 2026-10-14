import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getRuntimeAgentDataDirectory, type RuntimeHomeEnvironment } from "./runtime-home";

const COMPANION_DATA_FILENAME = "companion-runtime.json";
const COMPANION_STORAGE_CONFIG_FILENAME = "companion-storage.json";

interface CompanionStorageConfig {
  version: 1;
  directory: string;
}

export interface CompanionStorageInfo {
  directory: string;
  defaultDirectory: string;
  dataFile: string;
  configFile: string;
  customized: boolean;
}

function storageConfigPath(environment: RuntimeHomeEnvironment): string {
  return join(getRuntimeAgentDataDirectory(environment), "piora", COMPANION_STORAGE_CONFIG_FILENAME);
}

function defaultStorageDirectory(environment: RuntimeHomeEnvironment): string {
  return join(getRuntimeAgentDataDirectory(environment), "piora");
}

function normalizeStorageDirectory(value: string): string {
  const requested = value.trim();
  if (!requested || !isAbsolute(requested)) {
    throw new Error("Companion storage directory must be an absolute path");
  }
  const normalized = resolve(requested);
  if (normalized === parse(normalized).root) {
    throw new Error("Companion storage directory cannot be a filesystem root");
  }
  return normalized;
}

function readStorageDirectory(environment: RuntimeHomeEnvironment): string {
  const fallback = defaultStorageDirectory(environment);
  try {
    const parsed = JSON.parse(readFileSync(storageConfigPath(environment), "utf8")) as Partial<CompanionStorageConfig>;
    if (parsed.version !== 1 || typeof parsed.directory !== "string") return fallback;
    return normalizeStorageDirectory(parsed.directory);
  } catch {
    return fallback;
  }
}

export function getCompanionStorageInfo(
  environment: RuntimeHomeEnvironment = process.env,
): CompanionStorageInfo {
  const directory = readStorageDirectory(environment);
  const defaultDirectory = defaultStorageDirectory(environment);
  return {
    directory,
    defaultDirectory,
    dataFile: join(directory, COMPANION_DATA_FILENAME),
    configFile: storageConfigPath(environment),
    customized: directory !== defaultDirectory,
  };
}

export function getCompanionRuntimePath(
  environment: RuntimeHomeEnvironment = process.env,
): string {
  return getCompanionStorageInfo(environment).dataFile;
}

/**
 * Move the companion data file before switching the small, stable pointer
 * stored under the agent directory. The original is removed only after the
 * copied file and the new pointer have both been written successfully.
 */
export function updateCompanionStorageDirectory(
  requestedDirectory: string,
  environment: RuntimeHomeEnvironment = process.env,
): CompanionStorageInfo {
  const current = getCompanionStorageInfo(environment);
  const directory = normalizeStorageDirectory(requestedDirectory);
  if (directory === current.directory) return current;

  const destination = join(directory, COMPANION_DATA_FILENAME);
  if (existsSync(destination)) {
    throw new Error(`The selected folder already contains ${COMPANION_DATA_FILENAME}`);
  }

  mkdirSync(directory, { recursive: true });
  let copied = false;
  if (existsSync(current.dataFile)) {
    copyFileSync(current.dataFile, destination);
    copied = true;
    if (statSync(destination).size !== statSync(current.dataFile).size) {
      unlinkSync(destination);
      throw new Error("Companion data could not be verified after copying");
    }
  }

  try {
    const configFile = storageConfigPath(environment);
    mkdirSync(parse(configFile).dir, { recursive: true });
    writePrivateFileAtomicSync(configFile, `${JSON.stringify({ version: 1, directory } satisfies CompanionStorageConfig, null, 2)}\n`);
  } catch (error) {
    if (copied) {
      try { unlinkSync(destination); } catch { /* Leave the original data untouched. */ }
    }
    throw error;
  }

  if (copied) {
    try { unlinkSync(current.dataFile); } catch { /* A verified recovery copy may remain at the previous path. */ }
  }
  return getCompanionStorageInfo(environment);
}
