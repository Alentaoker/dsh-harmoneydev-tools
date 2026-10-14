import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security.ts";
import { parseUnifiedDiff } from "./diff-parse.ts";

const MAX_PATHS = 1_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export class GitWriteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = "git_write_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isAbsolute(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function nearestExistingParent(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function validateGitWritePaths(cwd: string, paths: unknown, allowedRoots: Set<string>): string[] {
  if (!cwd || !isAbsolute(cwd)) throw new GitWriteError("cwd must be an absolute path");
  if (!isExistingPathWithinRoots(cwd, allowedRoots)) throw new GitWriteError("Access denied", 403, "access_denied");
  if (!Array.isArray(paths) || paths.length === 0) throw new GitWriteError("paths must be a non-empty array");
  if (paths.length > MAX_PATHS) throw new GitWriteError(`paths cannot contain more than ${MAX_PATHS} entries`, 413, "too_many_paths");
  const realCwd = fs.realpathSync(cwd);
  return paths.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new GitWriteError("Each path must be a non-empty string");
    const relative = value.replace(/\\/g, "/");
    if (isAbsolute(value) || relative === ".." || relative.startsWith("../") || relative.split("/").includes("..")) {
      throw new GitWriteError(`Path traversal is not allowed: ${value}`, 400, "invalid_path");
    }
    if (relative.startsWith("-")) throw new GitWriteError(`Git flags are not allowed as paths: ${value}`);
    const resolved = path.resolve(realCwd, value);
    if (!isPathWithinRoots(resolved, new Set([realCwd]))) throw new GitWriteError(`Path escapes cwd: ${value}`, 403, "path_escape");
    const existingParent = nearestExistingParent(resolved);
    if (!isExistingPathWithinRoots(existingParent, new Set([realCwd]))) throw new GitWriteError(`Symbolic link escapes cwd: ${value}`, 403, "symlink_escape");
    return path.relative(realCwd, resolved).split(path.sep).join("/");
  });
}

interface GitResult { stdout: string; stderr: string; }

export async function runGit(cwd: string, args: string[], stdin?: string, timeoutMs = GIT_TIMEOUT_MS, envOverrides: Record<string, string> = {}): Promise<GitResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...envOverrides },
    });
    let stdout = ""; let stderr = ""; let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(new GitWriteError(error.message, 500, "spawn_failed")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new GitWriteError(`Git operation timed out after ${Math.round(timeoutMs / 1000)} seconds`, 504, "git_timeout"));
      if (size > MAX_OUTPUT_BYTES) return reject(new GitWriteError("Git output exceeded the safe limit", 413, "output_too_large"));
      if (code !== 0) return reject(new GitWriteError((stderr || stdout || `git exited with ${code}`).trim(), 409, "git_failed"));
      resolve({ stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

function assertPatchMatchesPaths(patchText: string, paths: string[]): void {
  if (!patchText || Buffer.byteLength(patchText, "utf8") > MAX_OUTPUT_BYTES) throw new GitWriteError("Patch is empty or exceeds the safe limit", 413, "invalid_patch");
  const allowed = new Set(paths.map((value) => value.replace(/\\/g, "/")));
  const parsed = parseUnifiedDiff(patchText);
  if (parsed.files.length === 0 || parsed.binary) throw new GitWriteError("Only text patches are supported", 400, "invalid_patch");
  for (const file of parsed.files) {
    const candidates = [file.oldPath, file.newPath].filter((value): value is string => Boolean(value && value !== "/dev/null"));
    if (!candidates.length || candidates.some((value) => !allowed.has(value.replace(/\\/g, "/")))) {
      throw new GitWriteError("Patch paths do not match the authorized files", 403, "patch_path_mismatch");
    }
  }
}

async function assertFreshHash(cwd: string, paths: string[], expectedHash?: string): Promise<void> {
  if (!expectedHash) throw new GitWriteError("diffHash is required for hunk operations");
  const actualHash = await computeGitDiffHash(cwd, paths);
  if (!/^[a-f0-9]{64}$/i.test(expectedHash) || actualHash !== expectedHash) throw new GitWriteError("The diff changed; refresh before applying the hunk", 409, "stale_diff");
}

async function assertRepositoryReady(cwd: string, allowConflicts = false): Promise<string> {
  let repositoryRoot: string;
  try { repositoryRoot = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim(); }
  catch { throw new GitWriteError("The selected directory is not a Git repository", 400, "not_git_repository"); }
  const status = (await runGit(cwd, ["status", "--porcelain=v1", "-z"])).stdout;
  for (const entry of status.split("\0")) {
    const code = entry.slice(0, 2);
    if (!allowConflicts && (code.includes("U") || code === "AA" || code === "DD")) throw new GitWriteError("Resolve Git conflicts before changing the index or working tree", 409, "conflict");
  }
  return repositoryRoot;
}

export async function computeGitDiffHash(cwd: string, paths: string[]): Promise<string> {
  await assertRepositoryReady(cwd);
  let diff = "";
  try { diff = (await runGit(cwd, ["diff", "--binary", "HEAD", "--", ...paths])).stdout; }
  catch { diff = (await runGit(cwd, ["diff", "--binary", "--", ...paths])).stdout; }
  const hash = createHash("sha256").update(diff);
  for (const relativePath of [...paths].sort()) {
    const absolute = path.resolve(cwd, relativePath);
    try {
      const tracked = await runGit(cwd, ["ls-files", "--error-unmatch", "--", relativePath]).then(() => true, () => false);
      if (!tracked && fs.statSync(absolute).isFile()) hash.update(relativePath).update(fs.readFileSync(absolute));
    } catch { /* Deleted and unreadable paths are represented by the Git diff. */ }
  }
  return hash.digest("hex");
}

export async function stageGitPaths(cwd: string, paths: string[], patchText?: string, expectedHash?: string): Promise<void> {
  // Staging a resolved conflict is how Git records the resolution. Other
  // write actions remain blocked until all unmerged entries are resolved.
  await assertRepositoryReady(cwd, true);
  if (patchText) {
    assertPatchMatchesPaths(patchText, paths);
    await assertFreshHash(cwd, paths, expectedHash);
    await runGit(cwd, ["apply", "--cached", "--unidiff-zero", "-"], patchText);
    return;
  }
  await runGit(cwd, ["add", "--", ...paths]);
}

export async function unstageGitPaths(cwd: string, paths: string[], patchText?: string, expectedHash?: string): Promise<void> {
  await assertRepositoryReady(cwd);
  if (patchText) {
    assertPatchMatchesPaths(patchText, paths);
    await assertFreshHash(cwd, paths, expectedHash);
    await runGit(cwd, ["apply", "--cached", "--reverse", "--unidiff-zero", "-"], patchText);
    return;
  }
  try { await runGit(cwd, ["restore", "--staged", "--", ...paths]); }
  catch (error) {
    if (!(error instanceof GitWriteError) || !/unborn|HEAD|initial/i.test(error.message)) throw error;
    await runGit(cwd, ["rm", "--cached", "--ignore-unmatch", "--", ...paths]);
  }
}

export async function revertGitPaths(cwd: string, paths: string[], expectedHash: string, patchText?: string): Promise<void> {
  await assertRepositoryReady(cwd);
  const actualHash = await computeGitDiffHash(cwd, paths);
  if (!/^[a-f0-9]{64}$/i.test(expectedHash) || actualHash !== expectedHash) throw new GitWriteError("The diff changed; refresh before reverting", 409, "stale_diff");
  if (patchText) {
    assertPatchMatchesPaths(patchText, paths);
    await runGit(cwd, ["apply", "--reverse", "--unidiff-zero", "-"], patchText);
    return;
  }
  for (const relativePath of paths) {
    const tracked = await runGit(cwd, ["ls-files", "--error-unmatch", "--", relativePath]).then(() => true, () => false);
    if (tracked) await runGit(cwd, ["restore", "--staged", "--worktree", "--", relativePath]);
    else {
      const absolute = path.resolve(cwd, relativePath);
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new GitWriteError(`Refusing to remove non-file path: ${relativePath}`, 409, "unsafe_revert");
      fs.unlinkSync(absolute);
    }
  }
}

export async function commitGit(cwd: string, message: string, amend = false, includeUnstaged = false): Promise<string> {
  await assertRepositoryReady(cwd);
  const normalized = message.trim();
  if (!normalized || normalized.length > 100_000) throw new GitWriteError("Commit message must be between 1 and 100000 characters");
  if (includeUnstaged) await runGit(cwd, ["add", "--all", "--", "."]);
  const args = ["commit", "--file=-"];
  if (amend) args.push("--amend");
  await runGit(cwd, args, `${normalized}\n`);
  return (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function pushGit(cwd: string): Promise<void> {
  await assertRepositoryReady(cwd);
  // Never infer a remote or use force. Git's configured upstream remains the
  // single source of truth and its error is returned when no upstream exists.
  await runGit(cwd, ["push"]);
}
