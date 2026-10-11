import { runGit, GitWriteError } from "./git-write.ts";
import { gitHttpCredentialEnvironment } from "./git-accounts";

const NETWORK_TIMEOUT_MS = 120_000;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/;

export interface GitRemote {
  name: string;
  fetchUrls: string[];
  pushUrls: string[];
}

export interface GitPushPreview {
  remote: string;
  pushUrl: string;
  accountId?: string;
  branch: string;
  targetBranch: string;
  localHead: string;
  remoteHead: string | null;
  ahead: number;
  behind: number;
  commits: { sha: string; subject: string }[];
}

function remoteName(value: string): string {
  if (!REMOTE_NAME.test(value) || value === "." || value === ".." || value.endsWith(".lock")) {
    throw new GitWriteError("Invalid remote name", 400, "invalid_remote");
  }
  return value;
}

function branchName(value: string): string {
  if (!BRANCH_NAME.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".lock")) {
    throw new GitWriteError("Invalid branch name", 400, "invalid_branch");
  }
  return value;
}

function remoteUrl(value: string): string {
  const url = value.trim();
  if (url.length > 2048 || /[\0\r\n\t]/.test(url)) throw new GitWriteError("Invalid remote URL", 400, "invalid_remote_url");
  if (/^https:\/\//i.test(url) || /^ssh:\/\//i.test(url)) {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new GitWriteError("Invalid remote URL", 400, "invalid_remote_url"); }
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new GitWriteError("Invalid remote URL", 400, "invalid_remote_url");
    return url;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(url) && !url.includes("..")) return url;
  throw new GitWriteError("Use an HTTPS or SSH Git URL", 400, "invalid_remote_url");
}

function visibleUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch { return value; }
}

function gitError(error: unknown): never {
  if (error instanceof GitWriteError) throw error;
  throw new GitWriteError(error instanceof Error ? error.message : String(error), 409, "remote_operation_failed");
}

async function git(cwd: string, args: string[], timeoutMs = 30_000, env: Record<string, string> = {}): Promise<string> {
  try { return (await runGit(cwd, args, undefined, timeoutMs, env)).stdout.trim(); }
  catch (error) { gitError(error); }
}

export async function listGitRemotes(cwd: string): Promise<GitRemote[]> {
  const names = (await git(cwd, ["remote"])).split(/\r?\n/).filter(Boolean);
  return Promise.all(names.map(async (name) => {
    const fetchUrls = (await git(cwd, ["remote", "get-url", "--all", name])).split(/\r?\n/).filter(Boolean).map(visibleUrl);
    const pushUrls = (await git(cwd, ["remote", "get-url", "--push", "--all", name])).split(/\r?\n/).filter(Boolean).map(visibleUrl);
    return { name, fetchUrls, pushUrls };
  }));
}

export async function addGitRemote(cwd: string, name: string, url: string): Promise<GitRemote[]> {
  await git(cwd, ["remote", "add", remoteName(name), remoteUrl(url)]);
  return listGitRemotes(cwd);
}

export async function changeGitRemote(cwd: string, name: string, next: { name?: string; url?: string; pushUrl?: string; replacePushUrl?: string }): Promise<GitRemote[]> {
  const current = remoteName(name);
  if (next.pushUrl !== undefined) {
    const previous = (await listGitRemotes(cwd)).find((item) => item.name === current);
    if (!previous) throw new GitWriteError("Remote does not exist", 404, "remote_not_found");
    if (previous.pushUrls.length > 1 && !next.replacePushUrl) throw new GitWriteError("Choose which push URL to replace", 400, "push_url_required");
    if (next.replacePushUrl && !previous.pushUrls.includes(next.replacePushUrl)) throw new GitWriteError("Push URL is not configured", 400, "invalid_push_url");
    const explicit = (await git(cwd, ["config", "--get-all", `remote.${current}.pushurl`]).catch(() => "")).split(/\r?\n/).filter(Boolean);
    await git(cwd, ["remote", "set-url", "--push", current, remoteUrl(next.pushUrl),
      ...(next.replacePushUrl && explicit.includes(next.replacePushUrl) ? [next.replacePushUrl] : [])]);
  }
  if (next.url !== undefined) await git(cwd, ["remote", "set-url", current, remoteUrl(next.url)]);
  if (next.name !== undefined && next.name !== current) await git(cwd, ["remote", "rename", current, remoteName(next.name)]);
  return listGitRemotes(cwd);
}

export async function removeGitRemote(cwd: string, name: string): Promise<GitRemote[]> {
  await git(cwd, ["remote", "remove", remoteName(name)]);
  return listGitRemotes(cwd);
}

export async function currentGitBranch(cwd: string): Promise<string> {
  const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return branchName(branch);
}

export async function previewGitPush(cwd: string, remote: string, targetBranch: string, requestedPushUrl?: string, accountId?: string): Promise<GitPushPreview> {
  remoteName(remote);
  branchName(targetBranch);
  const configured = (await listGitRemotes(cwd)).find((item) => item.name === remote);
  if (!configured) throw new GitWriteError("Remote does not exist", 404, "remote_not_found");
  if (configured.pushUrls.length > 1 && !requestedPushUrl) throw new GitWriteError("Choose one push URL", 400, "push_url_required");
  const pushUrl = requestedPushUrl ?? configured.pushUrls[0];
  if (!pushUrl || !configured.pushUrls.includes(pushUrl)) throw new GitWriteError("Push URL is not configured for this remote", 400, "invalid_push_url");
  const authEnv = await gitHttpCredentialEnvironment(pushUrl, accountId);
  const branch = await currentGitBranch(cwd);
  const localHead = await git(cwd, ["rev-parse", "HEAD"]);
  const targetRef = `refs/heads/${targetBranch}`;
  const lines = await git(cwd, ["ls-remote", "--heads", pushUrl, targetRef], NETWORK_TIMEOUT_MS, authEnv);
  const remoteHead = lines.split(/\r?\n/).find((line) => line.endsWith(`\t${targetRef}`))?.split("\t")[0] ?? null;
  let ahead = 0, behind = 0;
  if (remoteHead) {
    await git(cwd, ["fetch", "--no-tags", pushUrl, targetRef], NETWORK_TIMEOUT_MS, authEnv);
    const fetched = await git(cwd, ["rev-parse", "FETCH_HEAD"]);
    if (fetched !== remoteHead) throw new GitWriteError("Remote branch changed during preview; retry", 409, "stale_remote");
    const counts = (await git(cwd, ["rev-list", "--left-right", "--count", `${remoteHead}...${localHead}`])).split(/\s+/).map(Number);
    behind = counts[0] ?? 0;
    ahead = counts[1] ?? 0;
  } else {
    ahead = Number(await git(cwd, ["rev-list", "--count", localHead]));
  }
  const range = remoteHead ? `${remoteHead}..${localHead}` : localHead;
  const commits = (await git(cwd, ["log", "--format=%H%x09%s", "--max-count=100", range]))
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  return { remote, pushUrl, ...(accountId ? { accountId } : {}), branch, targetBranch, localHead, remoteHead, ahead, behind, commits };
}

export async function pushGitToRemote(cwd: string, expected: GitPushPreview, setUpstream: boolean): Promise<GitPushPreview> {
  const current = await previewGitPush(cwd, expected.remote, expected.targetBranch, expected.pushUrl, expected.accountId);
  const configured = (await listGitRemotes(cwd)).find((item) => item.name === current.remote);
  if (setUpstream && !configured?.fetchUrls.includes(current.pushUrl)) {
    throw new GitWriteError("Cannot set upstream when fetch and push URLs differ", 400, "upstream_url_mismatch");
  }
  const assignUpstream = async () => {
    const trackingRef = `refs/remotes/${current.remote}/${current.targetBranch}`;
    await git(cwd, ["update-ref", trackingRef, current.localHead]);
    await git(cwd, ["branch", `--set-upstream-to=${current.remote}/${current.targetBranch}`, current.branch]);
  };
  // A prior HTTP response may have been lost after the remote accepted the
  // push. Treat an exact matching remote head as success on retry.
  if (expected.ahead > 0 && expected.remoteHead !== expected.localHead
    && current.remoteHead === expected.localHead && current.localHead === expected.localHead
    && current.branch === expected.branch) {
    if (setUpstream) await assignUpstream();
    return current;
  }
  if (current.branch !== expected.branch || current.localHead !== expected.localHead || current.remoteHead !== expected.remoteHead) {
    throw new GitWriteError("Branch or remote changed; review the push again", 409, "stale_push_preview");
  }
  if (current.behind > 0) throw new GitWriteError("Remote has new commits; pull and resolve them before pushing", 409, "non_fast_forward");
  const refspec = `refs/heads/${current.branch}:refs/heads/${current.targetBranch}`;
  const authEnv = await gitHttpCredentialEnvironment(current.pushUrl, current.accountId);
  await git(cwd, ["push", "--porcelain", "--no-follow-tags", current.pushUrl, refspec], NETWORK_TIMEOUT_MS, authEnv);
  if (setUpstream) await assignUpstream();
  return current;
}
