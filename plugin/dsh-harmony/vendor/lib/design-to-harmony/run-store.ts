import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { designToHarmonyDataRoot } from "./data-root";
import { stableDesignHash } from "./stable-json";
import type { DesignAnalysisRun } from "./types";

interface RunStateFile {
  schema: 1;
  runs: DesignAnalysisRun[];
}

const MAX_RUNS = 30;
const MAX_RUN_STATE_BYTES = 24 * 1024 * 1024;

function emptyState(): RunStateFile {
  return { schema: 1, runs: [] };
}

function normalizedPath(value: string): string {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function isAnalysisRun(value: unknown): value is DesignAnalysisRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<DesignAnalysisRun>;
  return run.schemaVersion === 1
    && typeof run.id === "string"
    && typeof run.projectRoot === "string"
    && typeof run.importId === "string"
    && typeof run.sourceVersion === "string"
    && Array.isArray(run.targetNodeIds)
    && run.targetNodeIds.every((id) => typeof id === "string")
    && (run.scopeMode === undefined || run.scopeMode === "selection" || run.scopeMode === "flow")
    && ["planned", "generating", "generated", "ready_to_apply", "applying", "applied", "validating", "cancelling", "cancelled", "failed", "interrupted"].includes(run.status ?? "")
    && typeof run.revision === "number"
    && typeof run.createdAt === "string"
    && typeof run.updatedAt === "string";
}

export function designAnalysisRunId(projectRoot: string, importId: string, sourceVersion: string, targetNodeIds: string[], scopeMode: "selection" | "flow" = "selection"): string {
  const digest = stableDesignHash({
    schema: "piora-design-analysis-run-v1",
    projectRoot: normalizedPath(projectRoot),
    importId,
    sourceVersion,
    targetNodeIds: [...new Set(targetNodeIds)].sort(),
    ...(scopeMode === "flow" ? { scopeMode } : {}),
  });
  return `run_${digest.slice(0, 20)}`;
}

export class DesignAnalysisRunStore {
  readonly filePath: string;
  private mutation = Promise.resolve();

  constructor(root = designToHarmonyDataRoot()) {
    this.filePath = join(resolve(root), "analysis-runs.json");
    this.recoverInterruptedRuns();
  }

  private read(): RunStateFile {
    if (!existsSync(this.filePath)) return emptyState();
    try {
      if (statSync(this.filePath).size > MAX_RUN_STATE_BYTES) return emptyState();
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<RunStateFile>;
      if (parsed.schema !== 1 || !Array.isArray(parsed.runs)) return emptyState();
      return { schema: 1, runs: parsed.runs.filter(isAnalysisRun).slice(0, MAX_RUNS) };
    } catch {
      return emptyState();
    }
  }

  private write(state: RunStateFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private recoverInterruptedRuns(): void {
    const state = this.read();
    let changed = false;
    state.runs = state.runs.map((run) => {
      if (!['generating', 'applying', 'validating', 'cancelling'].includes(run.status)) return run;
      changed = true;
      return {
        ...run,
        status: "interrupted" as const,
        error: run.status === "applying"
          ? { code: "APPLY_FAILED", message: "Project apply was interrupted by a process restart", retryable: true }
          : run.status === "generating"
            ? { code: "GENERATION_FAILED", message: "Generation was interrupted by a process restart", retryable: true }
            : { code: "VALIDATION_CANCELLED", message: "Validation was interrupted by a process restart", retryable: true },
      };
    });
    if (changed) this.write(state);
  }

  private async mutate<T>(operation: (state: RunStateFile) => T): Promise<T> {
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

  list(projectRoot?: string): DesignAnalysisRun[] {
    return this.read().runs
      .filter((run) => !projectRoot || samePath(run.projectRoot, projectRoot))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): DesignAnalysisRun | undefined {
    return this.read().runs.find((run) => run.id === id);
  }

  findCached(projectRoot: string, importId: string, sourceVersion: string, targetNodeIds: string[], scopeMode: "selection" | "flow" = "selection"): DesignAnalysisRun | undefined {
    const id = designAnalysisRunId(projectRoot, importId, sourceVersion, targetNodeIds, scopeMode);
    const run = this.get(id);
    return run && samePath(run.projectRoot, projectRoot) && ["planned", "generated", "applied"].includes(run.status) ? run : undefined;
  }

  async save(run: DesignAnalysisRun): Promise<DesignAnalysisRun> {
    return this.mutate((state) => {
      state.runs = [run, ...state.runs.filter((candidate) => candidate.id !== run.id)]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_RUNS);
      return run;
    });
  }
}

declare global {
  var __pioraDesignAnalysisRunStore: DesignAnalysisRunStore | undefined;
  var __pioraDesignAnalysisStartLocks: Map<string, Promise<DesignAnalysisRun>> | undefined;
  var __pioraDesignGenerationStartLocks: Map<string, Promise<DesignAnalysisRun>> | undefined;
}

export function getDesignAnalysisRunStore(): DesignAnalysisRunStore {
  return globalThis.__pioraDesignAnalysisRunStore ??= new DesignAnalysisRunStore();
}

export function resetDesignAnalysisRunStoreForTests(): void {
  globalThis.__pioraDesignAnalysisRunStore = undefined;
  globalThis.__pioraDesignAnalysisStartLocks = undefined;
  globalThis.__pioraDesignGenerationStartLocks = undefined;
}

export async function runDesignGenerationOnce(
  id: string,
  operation: () => Promise<DesignAnalysisRun>,
): Promise<{ run: DesignAnalysisRun; joined: boolean }> {
  const locks = globalThis.__pioraDesignGenerationStartLocks ??= new Map();
  const existing = locks.get(id);
  if (existing) return { run: await existing, joined: true };
  const pending = Promise.resolve().then(operation);
  locks.set(id, pending);
  try {
    return { run: await pending, joined: false };
  } finally {
    if (locks.get(id) === pending) locks.delete(id);
  }
}

export async function runDesignAnalysisOnce(
  id: string,
  operation: () => Promise<DesignAnalysisRun>,
): Promise<{ run: DesignAnalysisRun; joined: boolean }> {
  const locks = globalThis.__pioraDesignAnalysisStartLocks ??= new Map();
  const existing = locks.get(id);
  if (existing) return { run: await existing, joined: true };
  const pending = Promise.resolve().then(operation);
  locks.set(id, pending);
  try {
    return { run: await pending, joined: false };
  } finally {
    if (locks.get(id) === pending) locks.delete(id);
  }
}
