import { GitWriteError, runGit } from "./git-write.ts";
import { currentGitBranch, listGitRemotes } from "./git-remotes.ts";

export type GitIntegrationMode = "ff-only" | "merge" | "rebase";

async function selectedRemote(cwd: string, remote: string): Promise<string> {
  if (!(await listGitRemotes(cwd)).some((item) => item.name === remote)) {
    throw new GitWriteError("Remote does not exist", 404, "remote_not_found");
  }
  return remote;
}

export async function fetchGitRemote(cwd: string, remote: string): Promise<void> {
  await runGit(cwd, ["fetch", "--prune", await selectedRemote(cwd, remote)], undefined, 120_000);
}

export async function pullGitBranch(cwd: string, remote: string, targetBranch: string, mode: GitIntegrationMode): Promise<void> {
  if (mode !== "ff-only" && mode !== "merge" && mode !== "rebase") throw new GitWriteError("Invalid integration mode");
  const branch = await currentGitBranch(cwd);
  const status = (await runGit(cwd, ["status", "--porcelain=v1", "-z"])).stdout;
  if (status) throw new GitWriteError("Commit or discard local changes before pulling", 409, "dirty_worktree");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/.test(targetBranch) || targetBranch.includes("..")) {
    throw new GitWriteError("Invalid target branch", 400, "invalid_branch");
  }
  await selectedRemote(cwd, remote);
  await runGit(cwd, ["pull", ...(mode === "ff-only" ? ["--ff-only"] : mode === "merge" ? ["--no-rebase", "--no-edit"] : ["--rebase"]), remote, targetBranch], undefined, 120_000);
  const after = await currentGitBranch(cwd);
  if (after !== branch) throw new GitWriteError("Current branch changed during pull", 409, "branch_changed");
}

export async function gitIntegrationState(cwd: string): Promise<"merge" | "rebase" | null> {
  const gitDir = (await runGit(cwd, ["rev-parse", "--git-dir"])).stdout.trim();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const absolute = path.resolve(cwd, gitDir);
  if (fs.existsSync(path.join(absolute, "rebase-merge")) || fs.existsSync(path.join(absolute, "rebase-apply"))) return "rebase";
  if (fs.existsSync(path.join(absolute, "MERGE_HEAD"))) return "merge";
  return null;
}

export async function finishGitIntegration(cwd: string, action: "continue" | "abort"): Promise<void> {
  const state = await gitIntegrationState(cwd);
  if (!state) throw new GitWriteError("No merge or rebase is in progress", 409, "no_integration");
  if (action === "abort") {
    await runGit(cwd, [state, "--abort"], undefined, 120_000);
    return;
  }
  const unmerged = (await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
  if (unmerged) throw new GitWriteError("Resolve and stage every conflicted file first", 409, "unresolved_conflicts");
  if (state === "merge") await runGit(cwd, ["commit", "--no-edit"], undefined, 120_000);
  else await runGit(cwd, ["rebase", "--continue"], undefined, 120_000, { GIT_EDITOR: ":" });
}
