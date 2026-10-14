import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../../atomic-file";
import { assertUnredirectedPathSync } from "./path-safety";
interface ForwardRecord { id: string; serial: string; pid: number; localPort: number; remotePort: number; state: "pending" | "established"; createdAt: string }
/** Crash records are diagnostic only: another process never removes these forwards automatically. */
export class ForwardOwnershipStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertUnredirectedPathSync(directory);
  }
  create(serial: string, localPort: number, remotePort: number): ForwardRecord {
    const record: ForwardRecord = { id: randomUUID(), serial, pid: process.pid, localPort, remotePort, state: "pending", createdAt: new Date().toISOString() };
    this.save(record); return record;
  }
  save(record: ForwardRecord) { writePrivateFileAtomicSync(join(this.directory, `${record.id}.json`), JSON.stringify(record)); }
  clear(record: ForwardRecord) { unlinkSync(join(this.directory, `${record.id}.json`)); }
  interrupted(serial: string): Array<{ localPort: number; remotePort: number; state: string }> {
    return readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
      let record: ForwardRecord;
      try { record = JSON.parse(readFileSync(join(this.directory, name), "utf8")); } catch { return []; }
      if (record.serial !== serial || !Number.isInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.localPort) || record.remotePort !== 53535) return [];
      try { process.kill(record.pid, 0); return []; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? [{ localPort: record.localPort, remotePort: record.remotePort, state: record.state }] : []; }
    });
  }
}
