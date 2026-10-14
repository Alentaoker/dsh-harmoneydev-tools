import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { TeamError } from "./team-errors";
import { getTeamRunStore } from "./team-run-store";
import type { PersistedTeamExecutionRef, TeamExecutionContext } from "./team-types";

interface SecretFile {
  schemaVersion: 1;
  tokens: Record<string, string>;
}

function readSecrets(path: string): SecretFile {
  if (!existsSync(path)) return { schemaVersion: 1, tokens: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SecretFile;
    if (parsed.schemaVersion !== 1 || !parsed.tokens || typeof parsed.tokens !== "object") throw new Error("invalid shape");
    return parsed;
  } catch {
    throw new TeamError("TEAM_INVALID_CONTEXT", "Team execution secret store is invalid.");
  }
}

function secretPath(roomId: string, teamRunId: string): string {
  return getTeamRunStore().paths(roomId, teamRunId).secrets;
}

export function persistTeamExecutionContext(context: TeamExecutionContext): PersistedTeamExecutionRef {
  const path = secretPath(context.roomId, context.teamRunId);
  mkdirSync(getTeamRunStore().runDirectory(context.roomId, context.teamRunId), { recursive: true, mode: 0o700 });
  const secrets = readSecrets(path);
  const leaseTokenRef = randomUUID();
  secrets.tokens[leaseTokenRef] = context.leaseToken;
  writePrivateFileAtomicSync(path, `${JSON.stringify(secrets)}\n`);
  const { leaseToken, ...safe } = context;
  void leaseToken;
  return { ...safe, leaseTokenRef };
}

export function resolveTeamExecutionContext(ref: PersistedTeamExecutionRef): TeamExecutionContext {
  const token = readSecrets(secretPath(ref.roomId, ref.teamRunId)).tokens[ref.leaseTokenRef];
  if (!token) throw new TeamError("TEAM_LEASE_INVALID", "Team execution lease secret is missing.");
  const { leaseTokenRef, ...safe } = ref;
  void leaseTokenRef;
  return { ...safe, leaseToken: token };
}

export function deleteTeamExecutionSecret(ref: PersistedTeamExecutionRef): void {
  const path = secretPath(ref.roomId, ref.teamRunId);
  const secrets = readSecrets(path);
  if (!(ref.leaseTokenRef in secrets.tokens)) return;
  delete secrets.tokens[ref.leaseTokenRef];
  writePrivateFileAtomicSync(path, `${JSON.stringify(secrets)}\n`);
}
