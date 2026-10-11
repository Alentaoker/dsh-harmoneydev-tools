export class SSHRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) { super(message); }
}

export async function sshRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new SSHRequestError(body?.error || `HTTP ${response.status}`, body?.code, response.status);
  if (!body) throw new SSHRequestError("Invalid server response");
  return body as T;
}

export function sshErrorText(error: unknown, t: (key: string) => string): string {
  if (error instanceof SSHRequestError && error.code && error.code !== "connection") return t(`ssh.error.${error.code}`);
  return error instanceof Error ? error.message : String(error);
}
