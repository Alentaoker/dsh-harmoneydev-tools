import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { designToHarmonyDataRoot } from "./data-root";
import { DesignToHarmonyError } from "./errors";
import { stableDesignHash } from "./stable-json";
import type { DesignManagedFileMode, DesignManagedFileRecord, DesignManagedProjectState } from "./types";

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_MANAGED_FILES = 2_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function normalizedProjectRoot(projectRoot: string): string {
  const value = resolve(projectRoot);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function projectRootsEqual(left: string, right: string): boolean {
  return normalizedProjectRoot(left) === normalizedProjectRoot(right);
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\0") || /^[A-Za-z]:/.test(value)) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && normalized.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function validRecord(value: unknown): value is DesignManagedFileRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<DesignManagedFileRecord>;
  return validRelativePath(record.relativePath)
    && (record.mode === "managed" || record.mode === "detached")
    && typeof record.sourceImportId === "string"
    && typeof record.sourceVersion === "string"
    && typeof record.planId === "string"
    && typeof record.previewId === "string"
    && typeof record.generatorVersion === "string"
    && Array.isArray(record.sourceNodeIds)
    && record.sourceNodeIds.every((id) => typeof id === "string")
    && typeof record.appliedSha256 === "string"
    && SHA256_PATTERN.test(record.appliedSha256)
    && typeof record.appliedAt === "string"
    && (record.detachedAt === undefined || typeof record.detachedAt === "string");
}

function emptyState(projectRoot: string): DesignManagedProjectState {
  return { schemaVersion: 1, projectRoot: resolve(projectRoot), revision: 0, files: [] };
}

export class DesignManagedStateStore {
  readonly root: string;
  private mutation = Promise.resolve();

  constructor(dataRoot = designToHarmonyDataRoot()) {
    this.root = join(resolve(dataRoot), "managed-projects");
  }

  pathFor(projectRoot: string): string {
    const key = stableDesignHash({ schema: "piora-design-managed-project-v1", projectRoot: normalizedProjectRoot(projectRoot) }).slice(0, 24);
    return join(this.root, `${key}.json`);
  }

  get(projectRoot: string): DesignManagedProjectState {
    const filePath = this.pathFor(projectRoot);
    if (!existsSync(filePath)) return emptyState(projectRoot);
    try {
      if (statSync(filePath).size > MAX_STATE_BYTES) return emptyState(projectRoot);
      const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DesignManagedProjectState>;
      if (value.schemaVersion !== 1
        || typeof value.projectRoot !== "string"
        || !projectRootsEqual(value.projectRoot, projectRoot)
        || !Number.isSafeInteger(value.revision)
        || Number(value.revision) < 0
        || !Array.isArray(value.files)
        || value.files.length > MAX_MANAGED_FILES
        || !value.files.every(validRecord)) return emptyState(projectRoot);
      const files = [...value.files]
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .filter((record, index, all) => index === 0 || all[index - 1]?.relativePath !== record.relativePath);
      return { schemaVersion: 1, projectRoot: resolve(projectRoot), revision: Number(value.revision), files };
    } catch {
      return emptyState(projectRoot);
    }
  }

  private write(state: DesignManagedProjectState): void {
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_STATE_BYTES || state.files.length > MAX_MANAGED_FILES) {
      throw new DesignToHarmonyError("APPLY_FAILED", "Managed design state exceeds its persistence limit", { status: 413, stage: "store" });
    }
    const filePath = this.pathFor(state.projectRoot);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(filePath, contents);
  }

  async replace(projectRoot: string, expectedRevision: number, files: DesignManagedFileRecord[]): Promise<DesignManagedProjectState> {
    let result!: DesignManagedProjectState;
    const next = this.mutation.then(() => {
      const current = this.get(projectRoot);
      if (current.revision !== expectedRevision) {
        throw new DesignToHarmonyError("PATCH_STALE", "Managed file state changed while applying the design patch", {
          status: 409,
          retryable: true,
          stage: "apply",
          details: { expectedRevision, actualRevision: current.revision },
        });
      }
      const normalized = [...files]
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .filter((record, index, all) => index === 0 || all[index - 1]?.relativePath !== record.relativePath);
      if (!normalized.every(validRecord)) {
        throw new DesignToHarmonyError("APPLY_FAILED", "Managed file state contains an invalid record", { status: 422, stage: "store" });
      }
      result = { schemaVersion: 1, projectRoot: resolve(projectRoot), revision: current.revision + 1, files: normalized };
      this.write(result);
    });
    this.mutation = next.catch(() => undefined);
    await next;
    return result;
  }

  async setMode(projectRoot: string, relativePath: string, mode: DesignManagedFileMode, expectedRevision: number): Promise<DesignManagedProjectState> {
    const current = this.get(projectRoot);
    const record = current.files.find((item) => item.relativePath === relativePath);
    if (!record) throw new DesignToHarmonyError("PATCH_CONFLICT", "Only an applied design file can change management mode", { status: 404, stage: "review" });
    const timestamp = new Date().toISOString();
    return this.replace(projectRoot, expectedRevision, current.files.map((item) => item.relativePath === relativePath
      ? { ...item, mode, ...(mode === "detached" ? { detachedAt: timestamp } : { detachedAt: undefined }) }
      : item));
  }
}

declare global {
  var __pioraDesignManagedStateStore: DesignManagedStateStore | undefined;
}

export function getDesignManagedStateStore(): DesignManagedStateStore {
  return globalThis.__pioraDesignManagedStateStore ??= new DesignManagedStateStore();
}

export function resetDesignManagedStateStoreForTests(): void {
  globalThis.__pioraDesignManagedStateStore = undefined;
}
