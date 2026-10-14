import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { designToHarmonyDataRoot } from "./data-root";
import { DesignToHarmonyError } from "./errors";
import { stableDesignHash, stableDesignJson } from "./stable-json";
import type { NormalizedDesignIR } from "./types";

const MAX_IR_BYTES = 16 * 1024 * 1024;
const RUN_ID_PATTERN = /^run_[a-f0-9]{20}$/;

function validateRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new DesignToHarmonyError("INVALID_ARGUMENT", "Invalid design analysis run id", { status: 400, stage: "store" });
  }
  return runId;
}

function isNormalizedIr(value: unknown): value is NormalizedDesignIR {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ir = value as Partial<NormalizedDesignIR>;
  if (ir.schemaVersion !== 1
    || typeof ir.sourceImportId !== "string"
    || typeof ir.sourceVersion !== "string"
    || !Array.isArray(ir.targetNodeIds)
    || !Array.isArray(ir.roots)
    || typeof ir.nodeCount !== "number"
    || typeof ir.hash !== "string") return false;
  const { hash, ...base } = ir;
  return stableDesignHash(base) === hash;
}

export class DesignAnalysisIrStore {
  readonly root: string;

  constructor(dataRoot = designToHarmonyDataRoot()) {
    this.root = join(resolve(dataRoot), "analysis-ir");
  }

  pathFor(runId: string): string {
    return join(this.root, `${validateRunId(runId)}.json`);
  }

  has(runId: string): boolean {
    try {
      return Boolean(this.get(runId));
    } catch {
      return false;
    }
  }

  get(runId: string): NormalizedDesignIR | undefined {
    const filePath = this.pathFor(runId);
    if (!existsSync(filePath)) return undefined;
    try {
      if (statSync(filePath).size > MAX_IR_BYTES) return undefined;
      const value = JSON.parse(readFileSync(filePath, "utf8"));
      return isNormalizedIr(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  save(runId: string, ir: NormalizedDesignIR): NormalizedDesignIR {
    if (!isNormalizedIr(ir)) {
      throw new DesignToHarmonyError("ANALYSIS_FAILED", "Normalized design IR failed its integrity check", { status: 422, stage: "store" });
    }
    const contents = `${stableDesignJson(ir)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_IR_BYTES) {
      throw new DesignToHarmonyError("ANALYSIS_TOO_LARGE", "Normalized design IR exceeds the persistence limit", { status: 413, stage: "store" });
    }
    const filePath = this.pathFor(runId);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(filePath, contents);
    return ir;
  }
}

declare global {
  var __pioraDesignAnalysisIrStore: DesignAnalysisIrStore | undefined;
}

export function getDesignAnalysisIrStore(): DesignAnalysisIrStore {
  return globalThis.__pioraDesignAnalysisIrStore ??= new DesignAnalysisIrStore();
}

export function resetDesignAnalysisIrStoreForTests(): void {
  globalThis.__pioraDesignAnalysisIrStore = undefined;
}
