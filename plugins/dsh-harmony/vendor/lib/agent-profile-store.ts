import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { getRuntimeAgentDataDirectory, type RuntimeHomeEnvironment } from "./runtime-home.ts";
import type { AgentRuntimeProfile } from "./agent-runtime-profile.ts";

const STORE_VERSION = 1;

export interface AgentProfileBinding {
  profile: AgentRuntimeProfile;
  boundAt: string;
}

export interface AgentProfileStore {
  version: 1;
  sessions: Record<string, AgentProfileBinding>;
}

export class AgentProfileStoreError extends Error {
  readonly code:
    | "INVALID_PROFILE_STORE"
    | "SESSION_PROFILE_MISSING"
    | "SESSION_PROFILE_MISMATCH"
    | "INVALID_SESSION_ID";

  constructor(
    code:
      | "INVALID_PROFILE_STORE"
      | "SESSION_PROFILE_MISSING"
      | "SESSION_PROFILE_MISMATCH"
      | "INVALID_SESSION_ID",
    message: string,
  ) {
    super(message);
    this.name = "AgentProfileStoreError";
    this.code = code;
  }
}

export function getAgentProfileStorePath(
  environment: RuntimeHomeEnvironment = process.env,
): string {
  return join(
    getRuntimeAgentDataDirectory(environment),
    "piora",
    "agent-runtime-profiles.json",
  );
}

function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 512 || /[\u0000-\u001f]/.test(sessionId)) {
    throw new AgentProfileStoreError("INVALID_SESSION_ID", "A valid session id is required.");
  }
}

function parseBinding(sessionId: string, value: unknown): AgentProfileBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentProfileStoreError(
      "INVALID_PROFILE_STORE",
      `Invalid runtime profile binding for session ${sessionId}.`,
    );
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.profile !== "normal" && candidate.profile !== "device-control") {
    throw new AgentProfileStoreError(
      "INVALID_PROFILE_STORE",
      `Invalid runtime profile for session ${sessionId}.`,
    );
  }
  if (typeof candidate.boundAt !== "string" || !candidate.boundAt) {
    throw new AgentProfileStoreError(
      "INVALID_PROFILE_STORE",
      `Invalid runtime profile timestamp for session ${sessionId}.`,
    );
  }
  return { profile: candidate.profile, boundAt: candidate.boundAt };
}

export function parseAgentProfileStore(raw: string): AgentProfileStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AgentProfileStoreError(
      "INVALID_PROFILE_STORE",
      `The Agent runtime profile store is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentProfileStoreError("INVALID_PROFILE_STORE", "The Agent runtime profile store must be an object.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== STORE_VERSION || !candidate.sessions || typeof candidate.sessions !== "object" || Array.isArray(candidate.sessions)) {
    throw new AgentProfileStoreError("INVALID_PROFILE_STORE", "The Agent runtime profile store has an unsupported shape or version.");
  }

  const sessions: Record<string, AgentProfileBinding> = {};
  for (const [sessionId, value] of Object.entries(candidate.sessions as Record<string, unknown>)) {
    assertSessionId(sessionId);
    sessions[sessionId] = parseBinding(sessionId, value);
  }
  return { version: STORE_VERSION, sessions };
}

export function readAgentProfileStore(path = getAgentProfileStorePath()): AgentProfileStore {
  try {
    return parseAgentProfileStore(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, sessions: {} };
    }
    throw error;
  }
}

/**
 * Fail closed when a just-created session cannot be bound to its runtime
 * profile. A marker is safer than leaving a valid unbound JSONL file that a
 * later normal process could mistake for a legacy session.
 */
export function quarantineUnboundSessionFile(path: string): void {
  try {
    unlinkSync(path);
    return;
  } catch (unlinkError) {
    try {
      renameSync(path, `${path}.profile-failed-${randomUUID()}.quarantine`);
      return;
    } catch (renameError) {
      try {
        writeFileSync(path, "PIORA_QUARANTINED_PROFILE_BINDING_FAILURE\n", {
          encoding: "utf8",
          flag: "w",
          mode: 0o600,
          flush: true,
        });
        return;
      } catch (overwriteError) {
        throw new AggregateError(
          [unlinkError, renameError, overwriteError],
          "Failed to quarantine a session after runtime profile persistence failed.",
        );
      }
    }
  }
}

export function readSessionAgentRuntimeProfile(
  sessionId: string,
  path = getAgentProfileStorePath(),
): AgentRuntimeProfile | undefined {
  assertSessionId(sessionId);
  return readAgentProfileStore(path).sessions[sessionId]?.profile;
}

export function isSessionVisibleInAgentRuntimeProfile(
  sessionId: string,
  currentProfile: AgentRuntimeProfile,
  store: AgentProfileStore,
): boolean {
  assertSessionId(sessionId);
  const binding = store.sessions[sessionId];
  if (currentProfile === "normal") return true;
  return binding?.profile === currentProfile;
}

async function withStoreLock<T>(path: string, operation: () => T | Promise<T>): Promise<T> {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    lockfilePath: `${path}.lock`,
    realpath: false,
    retries: { retries: 50, factor: 1.15, minTimeout: 4, maxTimeout: 50 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function bindSessionAgentRuntimeProfile(
  sessionId: string,
  profile: AgentRuntimeProfile,
  path = getAgentProfileStorePath(),
): Promise<AgentProfileBinding> {
  assertSessionId(sessionId);
  return withStoreLock(path, () => {
    const store = readAgentProfileStore(path);
    const existing = store.sessions[sessionId];
    if (existing) {
      if (existing.profile !== profile) {
        if (existing.profile === "device-control" && profile === "normal") {
          const migrated: AgentProfileBinding = { profile: "normal", boundAt: new Date().toISOString() };
          store.sessions[sessionId] = migrated;
          writePrivateFileAtomicSync(path, `${JSON.stringify(store, null, 2)}\n`);
          return migrated;
        }
        throw new AgentProfileStoreError(
          "SESSION_PROFILE_MISMATCH",
          `Session ${sessionId} is bound to ${existing.profile}, not ${profile}.`,
        );
      }
      return existing;
    }
    const binding: AgentProfileBinding = {
      profile,
      boundAt: new Date().toISOString(),
    };
    store.sessions[sessionId] = binding;
    writePrivateFileAtomicSync(path, `${JSON.stringify(store, null, 2)}\n`);
    return binding;
  });
}

/**
 * Resolve a persisted session for access from the current cold-start profile.
 * Legacy sessions may be migrated only into normal mode. Device-control never
 * guesses because doing so could turn an ordinary coding session into a device
 * controller with a different tool/resource boundary.
 */
export async function resolveSessionAgentRuntimeProfile(
  sessionId: string,
  currentProfile: AgentRuntimeProfile,
  path = getAgentProfileStorePath(),
): Promise<AgentRuntimeProfile> {
  assertSessionId(sessionId);
  const stored = readSessionAgentRuntimeProfile(sessionId, path);
  if (stored === undefined) {
    if (currentProfile !== "normal") {
      throw new AgentProfileStoreError(
        "SESSION_PROFILE_MISSING",
        `Session ${sessionId} has no runtime profile binding and cannot be opened in device-control mode.`,
      );
    }
    await bindSessionAgentRuntimeProfile(sessionId, "normal", path);
    return "normal";
  }
  if (stored !== currentProfile) {
    if (stored === "device-control" && currentProfile === "normal") {
      await bindSessionAgentRuntimeProfile(sessionId, "normal", path);
      return "normal";
    }
    throw new AgentProfileStoreError(
      "SESSION_PROFILE_MISMATCH",
      `Session ${sessionId} is bound to ${stored} and cannot run in the ${currentProfile} process.`,
    );
  }
  return stored;
}
