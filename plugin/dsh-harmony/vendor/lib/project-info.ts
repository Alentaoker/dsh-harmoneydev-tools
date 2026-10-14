import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 256 * 1024;

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C" },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function formatGitRepository(remoteUrl: string | null): string | undefined {
  if (!remoteUrl) return undefined;
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  const scpMatch = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  if (scpMatch?.[1]) return scpMatch[1].replace(/^\/+/, "");
  try {
    const url = new URL(trimmed);
    const repository = url.pathname.replace(/^\/+/, "");
    return repository || trimmed;
  } catch {
    return trimmed;
  }
}

export async function getProjectInfo(cwd: string): Promise<{
  repository?: string;
  branch?: string;
}> {
  const [remoteUrl, branch] = await Promise.all([
    git(cwd, ["config", "--get", "remote.origin.url"]),
    git(cwd, ["branch", "--show-current"]),
  ]);
  return {
    repository: formatGitRepository(remoteUrl),
    branch: branch ?? undefined,
  };
}

export interface ProjectStarterSignals {
  hasReadme: boolean;
  hasTests: boolean;
  hasPackageJson: boolean;
  hasOutdatedDependencies: boolean;
}

export async function getProjectStarterSignals(
  cwd: string,
  options: { includeOutdatedDependencies?: boolean } = {},
): Promise<ProjectStarterSignals> {
  let hasReadme = false;
  let hasTests = false;
  let visited = 0;
  const queue: Array<{ directory: string; depth: number }> = [{ directory: cwd, depth: 0 }];
  while (queue.length > 0 && visited < 2_000 && (!hasReadme || !hasTests)) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited++;
      const lower = entry.name.toLocaleLowerCase();
      if (entry.isFile() && /^readme(?:\.|$)/i.test(entry.name)) hasReadme = true;
      if (entry.isFile() && /(?:^|\.)(?:test|spec)\.[^.]+$/i.test(entry.name)) hasTests = true;
      if (entry.isDirectory() && (lower === "test" || lower === "tests" || lower === "__tests__")) hasTests = true;
      if (entry.isDirectory() && current.depth < 3 && !["node_modules", ".git", ".next", "dist", "build"].includes(lower)) {
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
  }
  const hasPackageJson = fs.existsSync(path.join(cwd, "package.json"));
  let hasOutdatedDependencies = false;
  if (hasPackageJson && options.includeOutdatedDependencies !== false) {
    try {
      const { stdout } = await execFileAsync(process.platform === "win32" ? "npm.cmd" : "npm", ["outdated", "--json", "--depth=0"], {
        cwd, timeout: 5_000, maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
      });
      hasOutdatedDependencies = Object.keys(JSON.parse(stdout || "{}") as object).length > 0;
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      try { hasOutdatedDependencies = Object.keys(JSON.parse(stdout || "{}") as object).length > 0; } catch { /* offline */ }
    }
  }
  return { hasReadme, hasTests, hasPackageJson, hasOutdatedDependencies };
}
