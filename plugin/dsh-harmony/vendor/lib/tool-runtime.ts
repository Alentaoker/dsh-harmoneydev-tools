import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform as hostPlatform } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

export type ToolRuntimeStatus = "available" | "missing" | "error";
export type ToolRuntimeSource = "managed" | "system" | "unavailable";

export interface ToolRuntimeInfo {
  id: "fd" | "rg";
  label: string;
  status: ToolRuntimeStatus;
  source: ToolRuntimeSource;
  path: string | null;
  version: string | null;
  offline: boolean;
  error?: string;
}

export type ManagedToolId = "fd" | "rg";

interface InspectOptions {
  agentDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  files?: Set<string>;
  run?: (command: string) => { status: number | null; stdout: string; stderr: string; error?: Error };
}

const DEFINITIONS = [
  { id: "fd" as const, label: "fd", binary: "fd", systemNames: ["fd", "fdfind"] },
  { id: "rg" as const, label: "ripgrep", binary: "rg", systemNames: ["rg"] },
];

type EnsureTool = (tool: ManagedToolId, onStatus?: (status: { type: string; message: string }) => void) => Promise<string | undefined>;

async function defaultEnsureTool(tool: ManagedToolId, onStatus?: (status: { type: string; message: string }) => void): Promise<string | undefined> {
  // package.json is not an exported subpath. The SDK exposes its real package
  // directory; load its shipped manager with Node rather than a Webpack context.
  const modulePath = pathToFileURL(join(getPackageDir(), "dist", "utils", "tools-manager.js")).href;
  const toolManager = await import(/* webpackIgnore: true */ modulePath) as { ensureTool: EnsureTool };
  return toolManager.ensureTool(tool, onStatus);
}

export async function installToolRuntime(
  tool: ManagedToolId,
  ensure: EnsureTool = defaultEnsureTool,
  onStatus?: (status: { type: string; message: string }) => void,
): Promise<{ path: string | null; status: "installed" | "unavailable" }> {
  const path = await ensure(tool, onStatus);
  return { path: path ?? null, status: path ? "installed" : "unavailable" };
}

function isOffline(env: NodeJS.ProcessEnv): boolean {
  const value = env.PI_OFFLINE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function defaultRun(command: string) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function parseVersion(output: string): string | null {
  const match = output.trim().match(/(?:^|\s)(?:v)?(\d+\.\d+(?:\.\d+)?(?:[-+][^\s]+)?)/i);
  return match?.[1] ?? null;
}

export function inspectToolRuntime(options: InspectOptions = {}): ToolRuntimeInfo[] {
  const agentDir = options.agentDir ?? getAgentDir();
  const platform = options.platform ?? hostPlatform();
  const files = options.files;
  const run = options.run ?? defaultRun;
  const env = options.env ?? process.env;
  const managedDir = join(agentDir, "bin");
  const binarySuffix = platform === "win32" ? ".exe" : "";
  const offline = isOffline(env);

  return DEFINITIONS.map((definition) => {
    const managedPath = join(managedDir, `${definition.binary}${binarySuffix}`);
    const managedExists = files ? files.has(managedPath) : existsSync(managedPath);
    const candidates = managedExists ? [managedPath] : definition.systemNames;
    for (const candidate of candidates) {
      const result = run(candidate);
      if (result.error || result.status !== 0) continue;
      return {
        id: definition.id,
        label: definition.label,
        status: "available" as const,
        source: candidate === managedPath ? "managed" as const : "system" as const,
        path: candidate,
        version: parseVersion(`${result.stdout}\n${result.stderr}`),
        offline,
      };
    }
    return {
      id: definition.id,
      label: definition.label,
      status: "missing" as const,
      source: "unavailable" as const,
      path: null,
      version: null,
      offline,
    };
  });
}
