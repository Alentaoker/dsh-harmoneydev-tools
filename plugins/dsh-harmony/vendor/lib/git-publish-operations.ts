import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRuntimeAgentDataDirectory } from "./runtime-home";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { GitWriteError } from "./git-write";

export interface GitPublishOperation {
  id: string;
  cwd: string;
  accountId: string;
  namespaceId: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  remoteName: string;
  phase: "creating" | "created" | "bound";
  url?: string;
  htmlUrl?: string;
  updatedAt: string;
}

function filePath() { return join(getRuntimeAgentDataDirectory(), "piora", "git", "publish-operations.json"); }

function readAll(): GitPublishOperation[] {
  if (!existsSync(filePath())) return [];
  try {
    const value = JSON.parse(readFileSync(filePath(), "utf8")) as unknown;
    if (!Array.isArray(value)) throw new Error("Expected array");
    return value.filter((item): item is GitPublishOperation => !!item && typeof item.id === "string" && typeof item.phase === "string");
  } catch { throw new GitWriteError("Publish operation journal is unreadable", 500, "publish_journal_error"); }
}

export function getGitPublishOperation(id: string): GitPublishOperation | undefined {
  return readAll().find((item) => item.id === id);
}

export function saveGitPublishOperation(operation: GitPublishOperation): void {
  const rows = readAll().filter((item) => item.id !== operation.id);
  rows.push({ ...operation, updatedAt: new Date().toISOString() });
  mkdirSync(dirname(filePath()), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(filePath(), `${JSON.stringify(rows.slice(-100), null, 2)}\n`);
}

declare global { var __pioraGitPublishLocks: Map<string, Promise<void>> | undefined; }
const locks = globalThis.__pioraGitPublishLocks ??= new Map();

export async function withGitPublishLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const prior = locks.get(id) ?? Promise.resolve();
  let release = () => {};
  const finished = new Promise<void>((resolve) => { release = resolve; });
  const current = prior.then(() => finished);
  locks.set(id, current);
  await prior;
  try { return await work(); }
  finally { release(); if (locks.get(id) === current) locks.delete(id); }
}
