import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getRuntimeAgentDataDirectory } from "./runtime-home";
import { decryptSSHCredential, encryptSSHCredential, sshVaultStatus } from "./ssh/vault";
import { GitWriteError } from "./git-write";

export type HostingProvider = "github" | "gitlab" | "gitee";
export interface GitAccount {
  id: string;
  provider: HostingProvider;
  site: string;
  label: string;
  username?: string;
  connectedAt: string;
}
interface StoredGitAccount extends GitAccount { sealedToken: string; }
interface TokenSet { accessToken: string; refreshToken: string | null; expiresAt: string | null; }
interface PendingLogin { verifier: string; provider: HostingProvider; site: string; flowId: string; expiresAt: number; }
declare global { var __pioraGitAuthPending: Map<string, PendingLogin> | undefined; }
const pending = globalThis.__pioraGitAuthPending ??= new Map();

function dataPath() { return join(getRuntimeAgentDataDirectory(), "piora", "git", "accounts.json"); }
function readAccounts(): StoredGitAccount[] {
  if (!existsSync(dataPath())) return [];
  try {
    const value = JSON.parse(readFileSync(dataPath(), "utf8")) as unknown;
    return Array.isArray(value) ? value.filter((item): item is StoredGitAccount =>
      !!item && typeof item.id === "string" && typeof item.sealedToken === "string" && typeof item.provider === "string") : [];
  } catch { throw new GitWriteError("Git accounts file is unreadable", 500, "account_store_error"); }
}

function saveAccounts(accounts: StoredGitAccount[]) {
  mkdirSync(dirname(dataPath()), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(dataPath(), `${JSON.stringify(accounts, null, 2)}\n`);
}

function brokerUrl(): URL {
  const value = process.env.PI_GIT_OAUTH_URL;
  if (!value) throw new GitWriteError("Configure the Git authorization service first", 503, "oauth_service_unconfigured");
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new GitWriteError("Git authorization service must use HTTPS", 503, "oauth_service_invalid");
  }
  return url;
}

async function broker<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, brokerUrl()), {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) { throw new GitWriteError(error instanceof Error ? error.message : "Git authorization service unavailable", 503, "oauth_service_unavailable"); }
  const data = await response.json() as T & { error?: string };
  if (!response.ok && response.status !== 202) throw new GitWriteError(data.error || `Authorization service returned ${response.status}`, response.status, "oauth_error");
  return data;
}

export async function availableGitProviders(): Promise<{ provider: HostingProvider; site: string }[]> {
  const data = await broker<{ providers: { id: HostingProvider; site: string }[] }>("/v1/providers");
  return data.providers.filter((item) => ["github", "gitlab", "gitee"].includes(item.id))
    .map((item) => ({ provider: item.id, site: item.site }));
}

export function listGitAccounts(): GitAccount[] {
  return readAccounts().map(publicGitAccount);
}

function publicGitAccount({ id, provider, site, label, username, connectedAt }: StoredGitAccount): GitAccount {
  return { id, provider, site, label, username, connectedAt };
}

async function accountUsername(provider: HostingProvider, site: string, accessToken: string): Promise<string | null> {
  const url = new URL(provider === "github" ? "https://api.github.com/user" : provider === "gitlab" ? "/api/v4/user" : "/api/v5/user", site);
  if (provider === "gitee") url.searchParams.set("access_token", accessToken);
  try {
    const response = await fetch(url, { headers: provider === "gitee" ? {} : { Authorization: `Bearer ${accessToken}` },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const data = await response.json() as { login?: unknown; username?: unknown };
    return typeof data.login === "string" ? data.login : typeof data.username === "string" ? data.username : null;
  } catch { return null; }
}

export async function beginGitLogin(provider: HostingProvider, site: string): Promise<{ operationId: string; authorizationUrl: string }> {
  const vault = await sshVaultStatus();
  if (!vault.unlocked) throw new GitWriteError("Unlock the credential vault first", 409, "vault_locked");
  const available = await availableGitProviders();
  if (!available.some((item) => item.provider === provider && item.site === site)) throw new GitWriteError("Git provider is not configured", 404, "provider_not_configured");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const result = await broker<{ flowId: string; authorizationUrl: string }>("/v1/flows", { provider, site, challenge });
  const operationId = randomUUID();
  pending.set(operationId, { verifier, provider, site, flowId: result.flowId, expiresAt: Date.now() + 10 * 60_000 });
  return { operationId, authorizationUrl: result.authorizationUrl };
}

export async function pollGitLogin(operationId: string): Promise<{ status: "pending" | "ready"; account?: GitAccount }> {
  const flow = pending.get(operationId);
  if (!flow || flow.expiresAt < Date.now()) { pending.delete(operationId); throw new GitWriteError("Authorization expired; sign in again", 410, "login_expired"); }
  const result = await broker<{ status: "pending" | "ready"; token?: TokenSet; provider?: HostingProvider; site?: string }>(
    `/v1/flows/${flow.flowId}/claim`, { verifier: flow.verifier });
  if (result.status === "pending") return { status: "pending" };
  pending.delete(operationId);
  if (result.provider !== flow.provider || result.site !== flow.site || !result.token?.accessToken) {
    throw new GitWriteError("Authorization response does not match the requested provider", 502, "oauth_mismatch");
  }
  const username = await accountUsername(flow.provider, flow.site, result.token.accessToken);
  const account: StoredGitAccount = {
    id: randomUUID(), provider: flow.provider, site: flow.site,
    label: `${flow.provider} · ${username || flow.site.replace(/^https?:\/\//, "")}`,
    ...(username ? { username } : {}),
    connectedAt: new Date().toISOString(),
    sealedToken: await encryptSSHCredential(JSON.stringify(result.token)),
  };
  saveAccounts([...readAccounts(), account]);
  return { status: "ready", account: publicGitAccount(account) };
}

export function removeGitAccount(id: string): GitAccount[] {
  const previous = readAccounts();
  if (!previous.some((item) => item.id === id)) throw new GitWriteError("Account not found", 404, "account_not_found");
  saveAccounts(previous.filter((item) => item.id !== id));
  return listGitAccounts();
}

export async function gitAccountAccess(id: string): Promise<{ account: GitAccount; token: string }> {
  const account = readAccounts().find((item) => item.id === id);
  if (!account) throw new GitWriteError("Account not found", 404, "account_not_found");
  let token = JSON.parse(await decryptSSHCredential(account.sealedToken)) as TokenSet;
  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now() + 60_000) {
    if (!token.refreshToken) throw new GitWriteError("Account authorization expired; sign in again", 401, "reauthorize");
    const response = await broker<{ token: TokenSet }>("/v1/refresh", { provider: account.provider, site: account.site, refreshToken: token.refreshToken });
    token = { ...response.token, refreshToken: response.token.refreshToken || token.refreshToken };
    account.sealedToken = await encryptSSHCredential(JSON.stringify(token));
    saveAccounts(readAccounts().map((item) => item.id === account.id ? account : item));
  }
  return { account: publicGitAccount(account), token: token.accessToken };
}

/** Send an OAuth token only to the matching HTTPS Git host, via this one Git
 * process's environment. No credential is written to .git/config or a URL. */
export async function gitHttpCredentialEnvironment(pushUrl: string, accountId?: string): Promise<Record<string, string>> {
  if (!accountId) return { GIT_TERMINAL_PROMPT: "0" };
  const { account, token } = await gitAccountAccess(accountId);
  let destination: URL;
  try { destination = new URL(pushUrl); }
  catch { throw new GitWriteError("Account sign-in applies only to HTTPS remotes", 400, "credential_url_mismatch"); }
  const site = new URL(account.site);
  if (destination.protocol !== "https:" || destination.hostname !== site.hostname || destination.port !== site.port) {
    throw new GitWriteError("The chosen account does not match this remote host", 400, "credential_url_mismatch");
  }
  const username = account.provider === "github" ? "x-access-token" : account.provider === "gitee" ? (account.username || "oauth2") : "oauth2";
  const basic = Buffer.from(`${username}:${token}`, "utf8").toString("base64");
  const existingCount = Number(process.env.GIT_CONFIG_COUNT || 0);
  const index = Number.isInteger(existingCount) && existingCount >= 0 && existingCount < 100 ? existingCount : 0;
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${site.origin}/.extraheader`,
    [`GIT_CONFIG_VALUE_${index}`]: `Authorization: Basic ${basic}`,
  };
}
