import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../../atomic-file";
import { readBoundedRegularFile } from "../runtime/bounded-file";
import { assertUnredirectedPathSync } from "../runtime/path-safety";
import { HarmonyError } from "../errors";
import type { validateDevelopmentOnDevice } from "./validation-chain";

type Report = Awaited<ReturnType<typeof validateDevelopmentOnDevice>> & { savedAt?: string };
/** Private diagnostics can contain app logs. Keep at most 20 completed reports. */
export class DevelopmentReportStore {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); assertUnredirectedPathSync(directory); }
  async list(projectRoot?: string): Promise<Report[]> {
    const records: Report[] = [];
    for (const name of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const record = JSON.parse((await readBoundedRegularFile(join(this.directory, name), 4 * 1024 * 1024)).toString("utf8")) as Report;
      if (record.id !== name.slice(0, -5) || typeof record.projectRoot !== "string") throw new HarmonyError("INVALID_RESPONSE", "Invalid development report");
      if (!projectRoot || resolve(record.projectRoot) === resolve(projectRoot)) records.push(record);
    }
    return records.sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
  }
  async save(report: Report): Promise<Report> {
    const saved = { ...report, savedAt: new Date().toISOString() };
    const bytes = JSON.stringify(saved);
    if (!/^[a-f0-9-]{36}$/.test(report.id) || Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new HarmonyError("INVALID_ARGUMENT", "Invalid or oversized development report");
    writePrivateFileAtomicSync(join(this.directory, `${report.id}.json`), bytes);
    for (const old of (await this.list()).slice(20)) unlinkSync(join(this.directory, `${old.id}.json`));
    return saved;
  }
}
