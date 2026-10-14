import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../../atomic-file";
import { HarmonyError } from "../errors";

interface RecoveryRecord { serial: string; processId: number; kind: "input" | "recording"; state: "active" | "uncertain"; updatedAt: string; resources?: Partial<Record<"input" | "recording", "active" | "uncertain">> }
/** Write-ahead ownership evidence survives a crash; never sends cleanup commands at startup. */
export class HarmonyRecoveryStore {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  private path(serial: string) { return join(this.directory, `${createHash("sha256").update(serial).digest("hex")}.json`); }
  record(serial: string, kind: RecoveryRecord["kind"], state: RecoveryRecord["state"]) {
    let resources: RecoveryRecord["resources"] = {};
    try { const previous: RecoveryRecord = JSON.parse(readFileSync(this.path(serial), "utf8")); if (previous.processId === process.pid) resources = previous.resources ?? { [previous.kind]: previous.state }; } catch { /* New record. */ }
    const record: RecoveryRecord = { serial, processId: process.pid, kind, state, updatedAt: new Date().toISOString(), resources: { ...resources, [kind]: state } };
    writePrivateFileAtomicSync(this.path(serial), JSON.stringify(record));
  }
  clear(serial: string, kind?: RecoveryRecord["kind"]) {
    if (kind) {
      try {
        const record: RecoveryRecord = JSON.parse(readFileSync(this.path(serial), "utf8"));
        const resources = record.resources ?? { [record.kind]: record.state };
        delete resources[kind];
        if (Object.keys(resources).length) { writePrivateFileAtomicSync(this.path(serial), JSON.stringify({ ...record, resources })); return; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { unlinkSync(this.path(serial)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  interrupted(): RecoveryRecord[] {
    return readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
      let record: RecoveryRecord;
      try { record = JSON.parse(readFileSync(join(this.directory, name), "utf8")); }
      catch { throw new HarmonyError("INVALID_RESPONSE", "A Harmony recovery record is corrupt; inspect local recovery data before controlling devices"); }
      if (typeof record.serial !== "string" || !Number.isInteger(record.processId) || record.processId <= 0) throw new HarmonyError("INVALID_RESPONSE", "Invalid Harmony recovery owner");
      try { process.kill(record.processId, 0); return []; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? [record] : []; }
    });
  }
}
