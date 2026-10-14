import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { spawnSync } from "node:child_process";

interface ShellPathSettings {
  getShellPath(): string | undefined;
  setShellPath(path: string | undefined): void;
}

interface WindowsBashDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  gitExecutables?: string[];
  exists?: (path: string) => boolean;
}

function gitExecutablesOnPath(): string[] {
  try {
    const result = spawnSync("where.exe", ["git.exe"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function getWindowsBashCandidates(env: NodeJS.ProcessEnv, gitExecutables: string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (path: string | undefined) => {
    if (!path) return;
    const normalized = win32.normalize(path);
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(normalized);
  };

  if (env.ProgramFiles) add(win32.join(env.ProgramFiles, "Git", "bin", "bash.exe"));
  if (env["ProgramFiles(x86)"]) add(win32.join(env["ProgramFiles(x86)"]!, "Git", "bin", "bash.exe"));
  if (env.LOCALAPPDATA) add(win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  if (env.GIT_INSTALL_ROOT) add(win32.join(env.GIT_INSTALL_ROOT, "bin", "bash.exe"));

  for (const executable of gitExecutables) {
    const executableDir = win32.dirname(executable);
    const installRoot = ["cmd", "bin"].includes(win32.basename(executableDir).toLocaleLowerCase())
      ? win32.dirname(executableDir)
      : executableDir;
    add(win32.join(installRoot, "bin", "bash.exe"));
    add(win32.join(installRoot, "usr", "bin", "bash.exe"));
  }

  return candidates;
}

export function discoverWindowsBash(options: WindowsBashDiscoveryOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const env = options.env ?? process.env;
  const gitExecutables = options.gitExecutables ?? gitExecutablesOnPath();
  const exists = options.exists ?? existsSync;
  return getWindowsBashCandidates(env, gitExecutables).find((candidate) => exists(candidate));
}

export function ensureWindowsBashShellPath(
  settings: ShellPathSettings,
  options: WindowsBashDiscoveryOptions = {},
): string | undefined {
  const configured = settings.getShellPath();
  if (configured || (options.platform ?? process.platform) !== "win32") return configured;
  const discovered = discoverWindowsBash(options);
  if (discovered) settings.setShellPath(discovered);
  return discovered;
}
