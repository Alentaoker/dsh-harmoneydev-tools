import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { designToHarmonyDataRoot } from "./data-root";
import type { DesignImportRecord, DesignSourceRef } from "./types";

interface ImportStateFile {
  schema: 1;
  imports: DesignImportRecord[];
}

const MAX_IMPORTS = 30;

function emptyState(): ImportStateFile {
  return { schema: 1, imports: [] };
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isImportRecord(value: unknown): value is DesignImportRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<DesignImportRecord>;
  return record.schemaVersion === 1
    && typeof record.id === "string"
    && typeof record.projectRoot === "string"
    && typeof record.importedAt === "string"
    && typeof record.updatedAt === "string"
    && Boolean(record.source && ["figma", "octo"].includes(record.source.provider ?? "") && typeof record.source.fileKey === "string")
    && Boolean(record.document && typeof record.document.name === "string");
}

export class DesignImportStore {
  readonly filePath: string;
  private mutation = Promise.resolve();

  constructor(root = designToHarmonyDataRoot()) {
    this.filePath = join(resolve(root), "imports.json");
  }

  private read(): ImportStateFile {
    if (!existsSync(this.filePath)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<ImportStateFile>;
      if (parsed.schema !== 1 || !Array.isArray(parsed.imports)) return emptyState();
      return { schema: 1, imports: parsed.imports.filter(isImportRecord).slice(0, MAX_IMPORTS) };
    } catch {
      return emptyState();
    }
  }

  private write(state: ImportStateFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async mutate<T>(operation: (state: ImportStateFile) => T): Promise<T> {
    let result!: T;
    const next = this.mutation.then(() => {
      const state = this.read();
      result = operation(state);
      this.write(state);
    });
    this.mutation = next.catch(() => undefined);
    await next;
    return result;
  }

  list(projectRoot?: string): DesignImportRecord[] {
    return this.read().imports
      .filter((record) => !projectRoot || samePath(record.projectRoot, projectRoot))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): DesignImportRecord | undefined {
    return this.read().imports.find((record) => record.id === id);
  }

  findCached(projectRoot: string, source: DesignSourceRef): DesignImportRecord | undefined {
    return this.list(projectRoot).find((record) => (
      record.source.provider === source.provider
      && record.source.fileKey === source.fileKey
      && (record.source.nodeId ?? "") === (source.nodeId ?? "")
    ));
  }

  async save(record: DesignImportRecord): Promise<DesignImportRecord> {
    return this.mutate((state) => {
      state.imports = [record, ...state.imports.filter((candidate) => candidate.id !== record.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_IMPORTS);
      return record;
    });
  }
}

declare global {
  var __pioraDesignImportStore: DesignImportStore | undefined;
}

export function getDesignImportStore(): DesignImportStore {
  return globalThis.__pioraDesignImportStore ??= new DesignImportStore();
}

export function resetDesignImportStoreForTests(): void {
  globalThis.__pioraDesignImportStore = undefined;
}
