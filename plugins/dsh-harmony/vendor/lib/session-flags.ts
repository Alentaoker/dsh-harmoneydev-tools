import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";

export interface SessionFlag {
  pinned?: boolean;
  archived?: boolean;
  pinnedAt?: string;
}

export type SessionFlags = Record<string, SessionFlag>;
export type SessionFlagPatch = Pick<SessionFlag, "pinned" | "archived">;

export function getSessionFlagsPath(): string {
  return join(getAgentDir(), "piora", "session-flags.json");
}

function cleanFlag(value: unknown): SessionFlag | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const flag: SessionFlag = {};
  if (typeof candidate.pinned === "boolean") flag.pinned = candidate.pinned;
  if (typeof candidate.archived === "boolean") flag.archived = candidate.archived;
  if (typeof candidate.pinnedAt === "string") flag.pinnedAt = candidate.pinnedAt;
  return flag;
}

export function parseSessionFlags(raw: string): SessionFlags {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const flags: SessionFlags = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      const flag = cleanFlag(value);
      if (sessionId && flag) flags[sessionId] = flag;
    }
    return flags;
  } catch {
    return {};
  }
}

export function readSessionFlags(path = getSessionFlagsPath()): SessionFlags {
  try {
    return parseSessionFlags(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function applySessionFlagPatch(
  flags: SessionFlags,
  sessionId: string,
  patch: SessionFlagPatch,
  now = new Date().toISOString(),
): SessionFlags {
  const previous = flags[sessionId] ?? {};
  const next: SessionFlag = { ...previous };
  if (typeof patch.pinned === "boolean") {
    next.pinned = patch.pinned;
    next.pinnedAt = patch.pinned ? previous.pinnedAt ?? now : undefined;
  }
  if (typeof patch.archived === "boolean") next.archived = patch.archived;
  return { ...flags, [sessionId]: next };
}

export async function updateSessionFlag(
  sessionId: string,
  patch: SessionFlagPatch,
  path = getSessionFlagsPath(),
): Promise<SessionFlags> {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    lockfilePath: `${path}.lock`,
    realpath: false,
    retries: { retries: 100, factor: 1.15, minTimeout: 4, maxTimeout: 100 },
  });
  try {
    const flags = applySessionFlagPatch(readSessionFlags(path), sessionId, patch);
    writePrivateFileAtomicSync(path, `${JSON.stringify(flags, null, 2)}\n`);
    return flags;
  } finally {
    await release();
  }
}
