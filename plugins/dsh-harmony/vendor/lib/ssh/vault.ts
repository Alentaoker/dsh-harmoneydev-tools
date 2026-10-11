import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRuntimeAgentDataDirectory } from "../runtime-home";
import { writePrivateFileAtomicSync } from "../atomic-file";

const root = () => join(getRuntimeAgentDataDirectory(), "piora", "ssh");
const configPath = () => join(root(), "vault.json");
const desktop = () => Boolean(process.env.PI_DESKTOP_TOKEN);
// The web process never exposes encrypted credential bodies to the renderer.
const verifier = (key: Buffer) => createHmac("sha256", key).update("piora-ssh-vault-v1").digest();
type VaultConfig = { version: 1; salt: string; check: string };
type Pending = { resolve: (value: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
declare global { var __pioraSSHVault: { key: Buffer | null; pending: Map<string, Pending>; listening: boolean } | undefined; }
const state = globalThis.__pioraSSHVault ??= { key: null, pending: new Map(), listening: false };

export class SSHVaultError extends Error {
  constructor(message: string, readonly code: "locked" | "unavailable" | "invalid" | "corrupt") { super(message); }
}

function config(): VaultConfig | null {
  if (!existsSync(configPath())) return null;
  try {
    const value = JSON.parse(readFileSync(configPath(), "utf8")) as VaultConfig;
    if (value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{64}$/.test(value.check)) throw new Error("Invalid vault metadata");
    return value;
  } catch { throw new SSHVaultError("SSH vault metadata is damaged", "corrupt"); }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (password.length < 8 || password.length > 1024) throw new SSHVaultError("Master password must have 8–1024 characters", "invalid");
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, key) => error ? reject(error) : resolve(key)));
}

async function desktopAvailable(): Promise<boolean> {
  if (!desktop()) return false;
  try { return await desktopCipher("status", "") === "available"; } catch { return false; }
}
export async function sshVaultStatus() {
  if (!config() && await desktopAvailable()) return { mode: "desktop" as const, configured: true, unlocked: true };
  return { mode: "master-password" as const, configured: !!config(), unlocked: state.key !== null };
}

export async function setSSHMasterPassword(password: string): Promise<void> {
  if (await desktopAvailable()) throw new SSHVaultError("Desktop uses system encryption", "invalid");
  if (config()) throw new SSHVaultError("SSH vault already exists", "invalid");
  const salt = randomBytes(16), key = await derive(password, salt);
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(configPath(), JSON.stringify({ version: 1, salt: salt.toString("hex"), check: verifier(key).toString("hex") }));
  state.key?.fill(0); state.key = key;
}

export async function unlockSSHVault(password: string): Promise<void> {
  const saved = config();
  if (!saved) throw new SSHVaultError("Set a master password first", "invalid");
  const key = await derive(password, Buffer.from(saved.salt, "hex"));
  if (!timingSafeEqual(verifier(key), Buffer.from(saved.check, "hex"))) { key.fill(0); throw new SSHVaultError("Incorrect master password", "invalid"); }
  state.key?.fill(0); state.key = key;
}

export function lockSSHVault(): void { state.key?.fill(0); state.key = null; }

async function desktopCipher(action: "encrypt" | "decrypt" | "status", value: string): Promise<string> {
  if (typeof process.send !== "function") throw new SSHVaultError("Desktop encryption is unavailable", "unavailable");
  if (!state.listening) {
    state.listening = true;
    process.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const item = message as { type?: unknown; requestId?: unknown; ok?: unknown; value?: unknown; error?: unknown };
      if (item.type !== "pi-desktop:ssh-vault-response" || typeof item.requestId !== "string") return;
      const pending = state.pending.get(item.requestId); if (!pending) return;
      clearTimeout(pending.timer); state.pending.delete(item.requestId);
      if (item.ok === true && typeof item.value === "string") pending.resolve(item.value);
      else pending.reject(new SSHVaultError(typeof item.error === "string" ? item.error : "Desktop encryption failed", "unavailable"));
    });
    process.on("disconnect", () => { for (const item of state.pending.values()) { clearTimeout(item.timer); item.reject(new SSHVaultError("Desktop encryption disconnected", "unavailable")); } state.pending.clear(); });
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.pending.delete(requestId); reject(new SSHVaultError("Desktop encryption timed out", "unavailable")); }, 15_000);
    state.pending.set(requestId, { resolve, reject, timer });
    try { process.send!({ type: "pi-desktop:ssh-vault-request", requestId, action, value }); }
    catch (error) { clearTimeout(timer); state.pending.delete(requestId); reject(error); }
  });
}

export async function encryptSSHCredential(plain: string): Promise<string> {
  if (!config() && await desktopAvailable()) return `desktop1.${await desktopCipher("encrypt", plain)}`;
  const key = state.key; if (!key) throw new SSHVaultError("Unlock the SSH vault first", "locked");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `web1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")}`;
}

export async function decryptSSHCredential(value: string): Promise<string> {
  if (value.startsWith("desktop1.")) {
    if (!await desktopAvailable()) throw new SSHVaultError("System encryption is unavailable for this credential", "unavailable");
    return desktopCipher("decrypt", value.slice(9));
  }
  if (!value.startsWith("web1.")) throw new SSHVaultError("This credential belongs to another encryption mode", "unavailable");
  const key = state.key; if (!key) throw new SSHVaultError("Unlock the SSH vault first", "locked");
  try {
    const bytes = Buffer.from(value.slice(5), "base64url");
    if (bytes.length < 29 || bytes.length > 2 * 1024 * 1024) throw new Error("Invalid encrypted credential");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch { throw new SSHVaultError("Unable to decrypt SSH credential", "corrupt"); }
}
