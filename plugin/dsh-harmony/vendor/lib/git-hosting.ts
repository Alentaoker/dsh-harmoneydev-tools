import { gitAccountAccess, type HostingProvider } from "./git-accounts";
import { GitWriteError } from "./git-write";

export interface HostingNamespace {
  id: string;
  label: string;
  kind: "user" | "organization";
}

interface Access { provider: HostingProvider; site: string; token: string; }

async function access(accountId: string): Promise<Access> {
  const result = await gitAccountAccess(accountId);
  return { provider: result.account.provider, site: result.account.site, token: result.token };
}

function endpoint(connection: Access, path: string): URL {
  if (connection.provider === "github") return new URL(path, "https://api.github.com");
  return new URL(connection.provider === "gitlab" ? `/api/v4${path}` : `/api/v5${path}`, connection.site);
}

async function request(connection: Access, path: string, method = "GET", payload?: Record<string, unknown>): Promise<unknown> {
  const url = endpoint(connection, path);
  if (connection.provider === "gitee" && method === "GET") url.searchParams.set("access_token", connection.token);
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (connection.provider === "github") {
    headers.Authorization = `Bearer ${connection.token}`;
    headers["X-GitHub-Api-Version"] = "2026-03-10";
  } else if (connection.provider === "gitlab") headers.Authorization = `Bearer ${connection.token}`;
  let body: string | undefined;
  if (payload) {
    if (connection.provider === "gitee") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams([...Object.entries(payload).map(([key, value]) => [key, String(value)]), ["access_token", connection.token]]).toString();
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    }
  }
  let response: Response;
  try { response = await fetch(url, { method, headers, body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) }); }
  catch { throw new GitWriteError("Cannot reach the Git hosting service", 503, "hosting_unavailable"); }
  const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
  if (!response.ok) {
    const raw = data.message || data.error || `HTTP ${response.status}`;
    const safe = raw.replaceAll(connection.token, "[redacted]");
    throw new GitWriteError(safe, response.status, response.status === 401 || response.status === 403 ? "hosting_auth_failed" : "hosting_api_failed");
  }
  return data;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitWriteError("Unexpected response from Git hosting service", 502, "hosting_response_invalid");
  return value as Record<string, unknown>;
}

export async function listHostingNamespaces(accountId: string): Promise<HostingNamespace[]> {
  const connection = await access(accountId);
  if (connection.provider === "gitlab") {
    const data = await request(connection, "/namespaces?owned=true&per_page=100");
    if (!Array.isArray(data)) throw new GitWriteError("Cannot list GitLab namespaces", 502, "hosting_response_invalid");
    return data.map((item) => asRecord(item)).filter((item) => typeof item.id === "number" && typeof item.full_path === "string")
      .map((item) => ({ id: String(item.id), label: String(item.full_path), kind: item.kind === "user" ? "user" as const : "organization" as const }));
  }
  const user = asRecord(await request(connection, "/user"));
  const login = typeof user.login === "string" ? user.login : typeof user.name === "string" ? user.name : "";
  if (!login) throw new GitWriteError("Cannot identify hosting account", 502, "hosting_response_invalid");
  const own: HostingNamespace = { id: login, label: login, kind: "user" };
  const orgPath = connection.provider === "github" ? "/user/orgs?per_page=100" : "/user/orgs?per_page=100";
  const orgs = await request(connection, orgPath);
  const groups = Array.isArray(orgs) ? orgs.map((item) => asRecord(item)).map((item) => {
    const id = typeof item.login === "string" ? item.login : typeof item.name === "string" ? item.name : "";
    return { id, label: id, kind: "organization" as const };
  }).filter((item) => item.id) : [];
  return [own, ...groups];
}

export interface CreateHostingRepositoryInput {
  accountId: string;
  namespaceId: string;
  name: string;
  description: string;
  visibility: "private" | "public";
}

export async function createHostingRepository(input: CreateHostingRepositoryInput): Promise<{ url: string; htmlUrl: string }> {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith(".git") || name.endsWith(".lock")) {
    throw new GitWriteError("Use 1–100 letters, numbers, dots, hyphens or underscores for the repository name", 400, "invalid_repository_name");
  }
  if (input.description.length > 500) throw new GitWriteError("Description is too long");
  if (input.visibility !== "private" && input.visibility !== "public") throw new GitWriteError("Invalid visibility");
  const namespaces = await listHostingNamespaces(input.accountId);
  const selected = namespaces.find((item) => item.id === input.namespaceId);
  if (!selected) throw new GitWriteError("Repository owner is unavailable", 400, "namespace_unavailable");
  const connection = await access(input.accountId);
  if (connection.provider === "gitee" && selected.kind === "user" && input.visibility === "public") {
    throw new GitWriteError("Gitee personal repositories can only be private; choose an organization for a public repository", 400, "gitee_personal_private_only");
  }
  let result: Record<string, unknown>;
  if (connection.provider === "github") {
    const path = selected.kind === "user" ? "/user/repos" : `/orgs/${encodeURIComponent(selected.id)}/repos`;
    result = asRecord(await request(connection, path, "POST", {
      name, description: input.description, private: input.visibility === "private", auto_init: false,
    }));
  } else if (connection.provider === "gitlab") {
    result = asRecord(await request(connection, "/projects", "POST", {
      name, path: name, namespace_id: Number(selected.id), description: input.description,
      visibility: input.visibility, initialize_with_readme: false,
    }));
  } else {
    const path = selected.kind === "user" ? "/user/repos" : `/orgs/${encodeURIComponent(selected.id)}/repos`;
    result = asRecord(await request(connection, path, "POST", {
      name, description: input.description, private: input.visibility === "private", auto_init: false,
    }));
  }
  const url = result.clone_url || result.http_url_to_repo;
  const htmlUrl = result.html_url || result.web_url;
  if (typeof url !== "string" || typeof htmlUrl !== "string") {
    throw new GitWriteError("Repository was created but its URL was missing; inspect your account before retrying", 502, "created_without_url");
  }
  return { url, htmlUrl };
}
