import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, lstat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HarmonyError } from "../errors";
import type { HarmonyDiagnostics, HarmonyManagerState, HarmonySnapshot } from "../types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0,12);
export function createSupportBundle(state: HarmonyManagerState, diagnostics: HarmonyDiagnostics, options: { includeTree?: boolean; includeScreenshot?: boolean; snapshot?: HarmonySnapshot } = {}) {
  const snapshot = options.snapshot;
  const bundle = {
    format: "piora-harmony-support-v1", createdAt: new Date().toISOString(),
    privacy: { rawAudio: false, rawLogs: false, inputText: false, tree: Boolean(options.includeTree), screenshot: Boolean(options.includeScreenshot) },
    runtime: { status: diagnostics.runtime.status, backend: diagnostics.runtime.backendKind, errorCode: diagnostics.runtime.error?.code },
    queue: diagnostics.queue,
    devices: state.devices.map(device => ({ device: digest(device.serial), state: device.state, model: device.model, os: device.osVersion, api: device.apiVersion, epoch: device.generation })),
    controls: state.controls?.map(control => ({ ...control, serial: digest(control.serial) })),
    leases: state.leases.map(lease => ({ device: digest(lease.serial), owner: digest(lease.owner.id), expiresAt: lease.expiresAt, deviceEpoch: lease.deviceEpoch, leaseEpoch: lease.leaseEpoch })),
    ...(options.includeTree && snapshot ? { observation: { quality: snapshot.quality, nodes: snapshot.nodes?.slice(0,1000) } } : {}),
    ...(options.includeScreenshot && snapshot?.screenshot ? { screenshot: snapshot.screenshot.data.toString("base64") } : {}),
  };
  const json = JSON.stringify(bundle, null, 2);
  if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new HarmonyError("INVALID_ARGUMENT", "Support bundle exceeds 8 MiB; omit private evidence or use a smaller screenshot");
  return json;
}
export async function saveSupportBundle(directory: string, json: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new HarmonyError("INVALID_ARGUMENT", "Support directory cannot be a symlink");
  const id = randomUUID(), filename = `support-${id}.json`, path = join(directory,filename);
  await writeFile(path,json,{flag:"wx",mode:0o600});
  // Delete only our own bounded support records; never arbitrary media or caller files.
  const files = (await readdir(directory)).filter(name => /^support-[a-f0-9-]{36}\.json$/.test(name));
  const entries = await Promise.all(files.map(async name => ({ name, info: await lstat(join(directory,name)) })));
  for (const entry of entries.filter(entry => entry.info.isFile() && !entry.info.isSymbolicLink()).sort((a,b)=>b.info.mtimeMs-a.info.mtimeMs).slice(10)) await unlink(join(directory,entry.name));
  return { id, filename, path, bytes: Buffer.byteLength(json), sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
}
