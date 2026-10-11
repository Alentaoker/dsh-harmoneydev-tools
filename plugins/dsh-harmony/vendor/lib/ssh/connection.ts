import { createHash } from "node:crypto";
import { Client } from "ssh2";
import type { SSHConnectionOptions } from "./types";

declare global { var __pioraSSHTrustedHosts: Map<string, string> | undefined; }
const trustedHosts = globalThis.__pioraSSHTrustedHosts ??= new Map<string, string>();

export class SSHValidationError extends Error {}

export function parseSSHConnection(value: unknown): SSHConnectionOptions {
  if (!value || typeof value !== "object") throw new SSHValidationError("Invalid connection settings");
  const body = value as Record<string, unknown>;
  if (typeof body.host !== "string" || !body.host.trim() || /[\s\0/]/.test(body.host.trim())) throw new SSHValidationError("Invalid host address");
  if (typeof body.username !== "string" || !body.username.trim() || /[\r\n\0]/.test(body.username)) throw new SSHValidationError("Username is required");
  const port = body.port ?? 22;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new SSHValidationError("Port must be between 1 and 65535");
  const auth = body.auth as Record<string, unknown> | undefined;
  if (!auth || (auth.type !== "password" && auth.type !== "privateKey")) throw new SSHValidationError("Authentication is required");
  if (auth.type === "password" && typeof auth.password !== "string") throw new SSHValidationError("Password is required");
  if (auth.type === "privateKey" && (typeof auth.privateKey !== "string" || !auth.privateKey.trim() || (auth.passphrase !== undefined && typeof auth.passphrase !== "string"))) throw new SSHValidationError("Private key is required");
  for (const key of ["cols", "rows"] as const) {
    if (body[key] !== undefined && (typeof body[key] !== "number" || !Number.isInteger(body[key]) || body[key] < 2 || body[key] > 1000)) throw new SSHValidationError("Invalid terminal size");
  }
  if (body.hostFingerprint !== undefined && typeof body.hostFingerprint !== "string") throw new SSHValidationError("Invalid host fingerprint");
  return {
    host: body.host.trim(), port, username: body.username.trim(),
    auth: auth.type === "password" ? { type: "password", password: auth.password as string } : { type: "privateKey", privateKey: auth.privateKey as string, ...(typeof auth.passphrase === "string" ? { passphrase: auth.passphrase } : {}) },
    ...(body.hostFingerprint ? { hostFingerprint: body.hostFingerprint as string } : {}),
    ...(body.cols ? { cols: body.cols as number } : {}), ...(body.rows ? { rows: body.rows as number } : {}),
  };
}

/** Authenticate only. Shell and SFTP creation are explicit, separate operations. */
export function authenticateSSH(options: SSHConnectionOptions, signal?: AbortSignal): Promise<{ client: Client; fingerprint: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint = "", settled = false;
    const identity = `${options.host}:${options.port ?? 22}`;
    const timer = setTimeout(() => fail(new Error("SSH connection timed out")), 20_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; cleanup(); client.destroy(); reject(error);
    };
    const abort = () => fail(new Error("SSH connection cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    client.on("error", fail);
    client.once("close", () => fail(new Error("SSH connection closed before authentication completed")));
    client.once("ready", () => {
      if (settled) return;
      settled = true; cleanup(); trustedHosts.set(identity, fingerprint);
      resolve({ client, fingerprint });
    });
    try {
      client.connect({
        host: options.host, port: options.port ?? 22, username: options.username,
        ...(options.auth.type === "password" ? { password: options.auth.password } : { privateKey: options.auth.privateKey, passphrase: options.auth.passphrase }),
        hostVerifier: (key: Buffer) => {
          fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
          const expected = options.hostFingerprint ?? trustedHosts.get(identity);
          return !expected || expected === fingerprint;
        },
        readyTimeout: 15_000,
      });
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}

export async function testSSHConnection(options: SSHConnectionOptions, signal?: AbortSignal): Promise<void> {
  const { client } = await authenticateSSH(options, signal);
  client.end();
}

export function sshErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SSHValidationError) return "invalid";
  if (/authentication|authenticate/i.test(message)) return "auth";
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  if (/host.*verif|fingerprint/i.test(message)) return "hostKey";
  if (/private key|passphrase/i.test(message)) return "key";
  if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(message)) return "network";
  return "connection";
}
