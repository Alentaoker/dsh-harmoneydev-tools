import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitWriteError } from "./git-write";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_LIMIT = 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_LIMIT,
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C" },
    });
    return stdout;
  } catch (cause) {
    const details = cause as { stderr?: string; stdout?: string; message?: string };
    throw new GitWriteError((details.stderr || details.stdout || details.message || "Git branch operation failed").trim(), 409, "branch_operation_failed");
  }
}

async function repositoryRoot(cwd: string): Promise<string> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!root) throw new GitWriteError("The selected directory is not a Git repository", 400, "not_git_repository");
  return root;
}

export interface GitBranchesResponse {
  currentBranch: string | null;
  branches: string[];
}

export async function getGitBranches(cwd: string): Promise<GitBranchesResponse> {
  const root = await repositoryRoot(cwd);
  const [currentOutput, branchesOutput] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
    git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]),
  ]);
  const branches = [...new Set(branchesOutput.split(/\r?\n/).map((branch) => branch.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return { currentBranch: currentOutput.trim() || null, branches };
}

export async function switchGitBranch(cwd: string, branch: string): Promise<GitBranchesResponse> {
  const target = branch.trim();
  if (!target || target.includes("\0")) throw new GitWriteError("branch must be a non-empty branch name");
  const root = await repositoryRoot(cwd);
  const available = await getGitBranches(root);
  if (!available.branches.includes(target)) throw new GitWriteError("The requested local branch does not exist", 404, "branch_not_found");
  if (available.currentBranch !== target) await git(root, ["switch", "--", target]);
  return await getGitBranches(root);
}
