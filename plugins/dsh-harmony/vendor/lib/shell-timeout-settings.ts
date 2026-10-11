import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 1_800;
export const MAX_SHELL_TIMEOUT_SECONDS = 2_147_483;

const configPath = (root: string) => join(root, "piora", "shell-timeout.json");

export function readShellTimeoutSeconds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = Number(env.PIORA_SHELL_TIMEOUT_SECONDS?.trim());
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.min(Math.floor(parsed), MAX_SHELL_TIMEOUT_SECONDS))
    : DEFAULT_SHELL_TIMEOUT_SECONDS;
}

export function readShellTimeoutSettings(
  root = getAgentDir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): { timeoutSeconds: number } {
  try {
    const value = JSON.parse(readFileSync(configPath(root), "utf8")) as { timeoutSeconds?: unknown };
    if (Number.isInteger(value?.timeoutSeconds) && (value.timeoutSeconds as number) >= 1
      && (value.timeoutSeconds as number) <= MAX_SHELL_TIMEOUT_SECONDS) {
      return { timeoutSeconds: value.timeoutSeconds as number };
    }
  } catch { /* A missing or unreadable preference uses the existing environment override. */ }
  return { timeoutSeconds: readShellTimeoutSeconds(env) };
}

export function writeShellTimeoutSettings(value: unknown, root = getAgentDir()): { timeoutSeconds: number } {
  const timeoutSeconds = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { timeoutSeconds?: unknown }).timeoutSeconds
    : undefined;
  if (!Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 || (timeoutSeconds as number) > MAX_SHELL_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be an integer between 1 and ${MAX_SHELL_TIMEOUT_SECONDS}`);
  }
  const settings = { timeoutSeconds: timeoutSeconds as number };
  const path = configPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}
