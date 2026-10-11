import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    const repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return repositoryRoot ? resolveExistingPath(repositoryRoot) : null;
  } catch {
    return null;
  }
}

function resolveExistingPath(candidate: string): string {
  const resolvedCandidate = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolvedCandidate);
  } catch {
    const parent = path.dirname(resolvedCandidate);
    if (parent === resolvedCandidate) return resolvedCandidate;
    return path.join(resolveExistingPath(parent), path.basename(resolvedCandidate));
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

async function readIgnoredPaths(repositoryRoot: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  return new Promise((resolve, reject) => {
    const child = spawn("git", [
      "-C",
      repositoryRoot,
      "check-ignore",
      "--no-index",
      "-z",
      "--stdin",
    ], {
      env: { ...process.env, LC_ALL: "C" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    };
    const timeout = setTimeout(() => fail(new Error("git check-ignore timed out")), GIT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > GIT_STATUS_MAX_BUFFER) fail(new Error("git check-ignore output is too large"));
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      // check-ignore exits 1 when none of the supplied paths are ignored.
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `git check-ignore exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve(new Set(stdout.split("\0").filter(Boolean)));
    });
    child.stdin.on("error", fail);
    child.stdin.end(`${paths.join("\0")}\0`);
  });
}

async function readVisibleStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const entries = await readStatusEntries(repositoryRoot);
  const ignoredPaths = await readIgnoredPaths(repositoryRoot, entries.map((entry) => entry.path));
  return entries.filter((entry) => !ignoredPaths.has(entry.path));
}

async function readBranchLabel(repositoryRoot: string): Promise<string | null> {
  try {
    return (await git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() || null;
  } catch {
    try {
      const sha = (await git(repositoryRoot, ["rev-parse", "--short", "HEAD"])).trim();
      return sha ? `HEAD ${sha}` : null;
    } catch {
      return null;
    }
  }
}

async function readUpstream(repositoryRoot: string): Promise<{ upstream: string | null; ahead: number; behind: number }> {
  try {
    const upstream = (await git(repositoryRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
    const counts = (await git(repositoryRoot, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim().split(/\s+/).map(Number);
    return { upstream, ahead: counts[0] ?? 0, behind: counts[1] ?? 0 };
  } catch { return { upstream: null, ahead: 0, behind: 0 }; }
}

async function readTrackedLineStats(
  repositoryRoot: string,
  cwd: string,
  ignoredPaths: ReadonlySet<string> = new Set(),
): Promise<{ additions: number; deletions: number; byPath: Map<string, { additions: number; deletions: number }> }> {
  const relativeCwd = toGitPath(path.relative(repositoryRoot, cwd));
  const pathspec = relativeCwd || ".";
  try {
    const output = await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--numstat",
      "HEAD",
      "--",
      pathspec,
    ]);
    let additions = 0;
    let deletions = 0;
    const byPath = new Map<string, { additions: number; deletions: number }>();
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted, filePath] = line.split("\t", 3);
      if (filePath && ignoredPaths.has(filePath)) continue;
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
      if (filePath) byPath.set(filePath, {
        additions: Number.isInteger(addedCount) ? addedCount : 0,
        deletions: Number.isInteger(deletedCount) ? deletedCount : 0,
      });
    }
    return { additions, deletions, byPath };
  } catch {
    return { additions: 0, deletions: 0, byPath: new Map() };
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const resolvedCwd = resolveExistingPath(cwd);
  const repositoryRoot = await findRepositoryRoot(resolvedCwd);
  if (!repositoryRoot) {
    return {
      isGitRepository: false,
      repositoryRoot: null,
      branch: null,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }

  const [allEntries, branch, tracking] = await Promise.all([readStatusEntries(repositoryRoot), readBranchLabel(repositoryRoot), readUpstream(repositoryRoot)]);
  const ignoredPaths = await readIgnoredPaths(repositoryRoot, allEntries.map((entry) => entry.path));
  const entries = allEntries.filter((entry) => !ignoredPaths.has(entry.path));
  const trackedLineStats = await readTrackedLineStats(repositoryRoot, resolvedCwd, ignoredPaths);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    const filePath = path.resolve(repositoryRoot, entry.path);
    if (!isWithinPath(resolvedCwd, filePath)) return [];
    const classified = classifyGitStatus(entry);
    const lineStats = trackedLineStats.byPath.get(entry.path);
    return [{
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
      // Untracked files are visible as changes, but they are not part of the
      // repository diff until Git starts tracking them. Keep their line stats
      // at zero so the conversation header reports only tracked changes.
      additions: lineStats?.additions ?? 0,
      deletions: lineStats?.deletions ?? 0,
    }];
  });

  return {
    isGitRepository: true,
    repositoryRoot,
    branch,
    ...tracking,
    files,
    additions: trackedLineStats.additions,
    deletions: trackedLineStats.deletions,
  };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
  scope: "combined" | "staged" | "worktree" = "combined",
  contextLines: number | "all" = 3,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    const args = ["diff", "--no-color", "--no-ext-diff", `--unified=${contextLines === "all" ? 1_000_000 : contextLines}`];
    if (scope === "staged") args.push("--cached");
    else if (scope === "combined") args.push("HEAD");
    args.push("--", ...paths);
    return await git(repositoryRoot, args, TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

function countTextLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

async function readDisplayedLineCount(
  repositoryRoot: string,
  relativePath: string,
  status: GitFileStatus["status"],
  scope: "combined" | "staged" | "worktree",
  worktreeContent?: string,
): Promise<number | undefined> {
  if (status !== "deleted" && scope !== "staged" && worktreeContent !== undefined) {
    return countTextLines(worktreeContent);
  }
  const revision = status === "deleted" && scope !== "worktree"
    ? `HEAD:${relativePath}`
    : `:${relativePath}`;
  try {
    return countTextLines(await git(repositoryRoot, ["show", revision], TEXT_PREVIEW_MAX_BYTES * 2));
  } catch {
    return undefined;
  }
}

export async function getGitFileDiff(
  cwd: string,
  filePath: string,
  scope: "combined" | "staged" | "worktree" = "combined",
  contextLines: number | "all" = 3,
): Promise<GitFileDiffResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) return { supported: false };

  // Git for Windows reports the canonical long repository path even when the
  // caller arrived through an 8.3 short path or a directory junction. Resolve
  // the requested path (including the nearest existing parent for deletions)
  // before applying the repository containment boundary.
  const resolvedFilePath = resolveExistingPath(filePath);
  if (!isWithinPath(repositoryRoot, resolvedFilePath)) return { supported: false };
  const relativePath = toGitPath(path.relative(repositoryRoot, resolvedFilePath));
  const entries = await readVisibleStatusEntries(repositoryRoot);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath, scope, contextLines);
    if (!patch?.includes("\n@@ ")) return { supported: false };
    return {
      supported: true,
      status,
      patch,
      totalLines: await readDisplayedLineCount(repositoryRoot, relativePath, status, scope),
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedFilePath);
  } catch {
    return { supported: false };
  }
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  const currentBuffer = fs.readFileSync(resolvedFilePath);
  if (hasNullByte(currentBuffer)) return { supported: false };
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath, scope, contextLines);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return {
    supported: true,
    status,
    patch,
    totalLines: await readDisplayedLineCount(repositoryRoot, relativePath, status, scope, newContent),
  };
}
