import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { DesignToHarmonyError } from "./errors";

const TOKEN_TTL_MS = 5 * 60 * 1_000;
const MAX_TOKENS = 100;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

interface DesignApplyTokenRecord {
  token: string;
  runId: string;
  projectRoot: string;
  expectedRevision: number;
  patchHash: string;
  overwritePaths: string[];
  expiresAt: number;
}

function comparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function tokenStore(): Map<string, DesignApplyTokenRecord> {
  const store = globalThis.__pioraDesignApplyTokens ??= new Map();
  const now = Date.now();
  for (const [token, record] of store) if (record.expiresAt <= now) store.delete(token);
  while (store.size >= MAX_TOKENS) store.delete(store.keys().next().value as string);
  return store;
}

export function issueDesignApplyToken(input: Omit<DesignApplyTokenRecord, "token" | "expiresAt">): {
  token: string;
  expiresAt: string;
} {
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  tokenStore().set(token, { ...input, projectRoot: resolve(input.projectRoot), token, expiresAt });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeDesignApplyToken(input: {
  token: unknown;
  runId: string;
  projectRoot: string;
  expectedRevision: number;
  patchHash: string;
}): DesignApplyTokenRecord {
  if (typeof input.token !== "string" || !TOKEN_PATTERN.test(input.token)) {
    throw new DesignToHarmonyError("APPLY_TOKEN_INVALID", "A valid apply token is required", { status: 403, stage: "apply" });
  }
  const store = tokenStore();
  const record = store.get(input.token);
  store.delete(input.token);
  if (!record
    || record.expiresAt <= Date.now()
    || record.runId !== input.runId
    || comparablePath(record.projectRoot) !== comparablePath(input.projectRoot)
    || record.expectedRevision !== input.expectedRevision
    || record.patchHash !== input.patchHash) {
    throw new DesignToHarmonyError("APPLY_TOKEN_INVALID", "The apply token expired or no longer matches this reviewed patch", {
      status: 403,
      retryable: true,
      stage: "apply",
    });
  }
  return record;
}

declare global {
  var __pioraDesignApplyTokens: Map<string, DesignApplyTokenRecord> | undefined;
}

export function resetDesignApplyTokensForTests(): void {
  globalThis.__pioraDesignApplyTokens = undefined;
}
