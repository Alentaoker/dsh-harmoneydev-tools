import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getRuntimeAgentDataDirectory, getRuntimeHomeDirectory } from "../runtime-home";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { parseSSHConnection, SSHValidationError } from "./connection";
import { decryptSSHCredential, encryptSSHCredential } from "./vault";
import type { SSHAuth, SSHConnectionOptions } from "./types";

export interface SSHSavedHost {
  id: string; name: string; host: string; port: number; username: string;
  authType: SSHAuth["type"]; hasCredential: boolean; hostFingerprint?: string;
}
type RecordOnDisk = Omit<SSHSavedHost, "hasCredential"> & { credentialId?: string };
const metadataPath = () => join(getRuntimeAgentDataDirectory(), "piora", "ssh", "hosts.json");
const credentialDirectory = () => join(getRuntimeHomeDirectory(), ".piora", "ssh-vault");
const credentialPath = (id: string) => join(credentialDirectory(), `${id}.enc`);
let writes: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> { const next = writes.then(operation, operation); writes = next.catch(() => undefined); return next; }
function records(): RecordOnDisk[] {
  if (!existsSync(metadataPath())) return [];
  const file = JSON.parse(readFileSync(metadataPath(), "utf8"));
  if (file.version !== 1 || !Array.isArray(file.hosts)) throw new Error("SSH host list is damaged");
  return file.hosts;
}
function save(items: RecordOnDisk[]): void { mkdirSync(join(getRuntimeAgentDataDirectory(), "piora", "ssh"), { recursive: true, mode: 0o700 }); writePrivateFileAtomicSync(metadataPath(), JSON.stringify({ version: 1, hosts: items })); }
function publicHost(item: RecordOnDisk): SSHSavedHost { const { credentialId: _secret, ...host } = item; void _secret; return { ...host, hasCredential: !!item.credentialId }; }
function find(items: RecordOnDisk[], id: string): RecordOnDisk {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new SSHValidationError("Invalid host ID");
  const item = items.find(host => host.id === id); if (!item) throw new SSHValidationError("Saved host not found"); return item;
}
function nameOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\r\n\0]/.test(value)) throw new SSHValidationError("Host name must be 1–80 characters");
  return value.trim();
}
function unique(items: RecordOnDisk[], name: string, except?: string): void {
  if (items.some(item => item.id !== except && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new SSHValidationError("A host with this name already exists");
}
export function listSSHHosts(): SSHSavedHost[] { return records().map(publicHost); }
export function getSSHHost(id: string): SSHSavedHost { return publicHost(find(records(), id)); }
export function createSSHHost(input: unknown): Promise<SSHSavedHost> {
  return serial(async () => {
    if (!input || typeof input !== "object") throw new SSHValidationError("Invalid host settings");
    const body = input as Record<string, unknown>, name = nameOf(body.name), options = parseSSHConnection(body), items = records(); unique(items, name);
    const id = randomUUID(), credentialId = randomUUID(), encrypted = await encryptSSHCredential(JSON.stringify(options.auth));
    mkdirSync(credentialDirectory(), { recursive: true, mode: 0o700 }); writePrivateFileAtomicSync(credentialPath(credentialId), encrypted);
    const record: RecordOnDisk = { id, name, host: options.host, port: options.port ?? 22, username: options.username, authType: options.auth.type, credentialId, ...(options.hostFingerprint ? { hostFingerprint: options.hostFingerprint } : {}) };
    try { save([...items, record]); } catch (error) { unlinkSync(credentialPath(credentialId)); throw error; }
    return publicHost(record);
  });
}
export function updateSSHHost(id: string, input: unknown): Promise<SSHSavedHost> {
  return serial(async () => {
    if (!input || typeof input !== "object") throw new SSHValidationError("Invalid host settings");
    const body = input as Record<string, unknown>, items = records(), old = find(items, id);
    const name = body.name === undefined ? old.name : nameOf(body.name); unique(items, name, id);
    const replace = body.auth !== undefined, clear = body.clearCredential === true;
    if (replace && clear) throw new SSHValidationError("Cannot replace and clear a credential together");
    const placeholder: SSHAuth = old.authType === "password" ? { type: "password", password: "" } : { type: "privateKey", privateKey: "placeholder" };
    const options = parseSSHConnection({ host: body.host ?? old.host, port: body.port ?? old.port, username: body.username ?? old.username, auth: replace ? body.auth : placeholder });
    const credentialId = replace ? randomUUID() : clear ? undefined : old.credentialId;
    if (replace) { const encrypted = await encryptSSHCredential(JSON.stringify(options.auth)); mkdirSync(credentialDirectory(), { recursive: true, mode: 0o700 }); writePrivateFileAtomicSync(credentialPath(credentialId!), encrypted); }
    const updated: RecordOnDisk = { ...old, name, host: options.host, port: options.port ?? 22, username: options.username, authType: replace ? options.auth.type : old.authType, ...(credentialId ? { credentialId } : {}) };
    if (!credentialId) delete updated.credentialId;
    if (old.host !== updated.host || old.port !== updated.port) delete updated.hostFingerprint;
    try { save(items.map(item => item.id === id ? updated : item)); } catch (error) { if (replace) unlinkSync(credentialPath(credentialId!)); throw error; }
    if (old.credentialId && old.credentialId !== credentialId) { try { unlinkSync(credentialPath(old.credentialId)); } catch { /* an orphaned ciphertext has no metadata reference */ } }
    return publicHost(updated);
  });
}
export function deleteSSHHost(id: string): Promise<void> {
  return serial(async () => { const items = records(), old = find(items, id); save(items.filter(item => item.id !== id)); if (old.credentialId) { try { unlinkSync(credentialPath(old.credentialId)); } catch { /* credential was already missing */ } } });
}
export async function connectionForSSHHost(id: string): Promise<SSHConnectionOptions> {
  const item = find(records(), id); if (!item.credentialId) throw new SSHValidationError("Saved host has no credential");
  const auth = JSON.parse(await decryptSSHCredential(readFileSync(credentialPath(item.credentialId), "utf8"))) as SSHAuth;
  return parseSSHConnection({ host: item.host, port: item.port, username: item.username, auth, ...(item.hostFingerprint ? { hostFingerprint: item.hostFingerprint } : {}) });
}
export function rememberSSHHostFingerprint(id: string, fingerprint: string): Promise<void> {
  return serial(async () => { const items = records(), item = find(items, id); if (item.hostFingerprint && item.hostFingerprint !== fingerprint) throw new SSHValidationError("SSH host fingerprint changed"); if (!item.hostFingerprint) save(items.map(host => host.id === id ? { ...host, hostFingerprint: fingerprint } : host)); });
}
