import { getAgentRuntimeProfile, type AgentRuntimeProfile } from "./agent-runtime-profile";
import { resolveSessionAgentRuntimeProfile } from "./agent-profile-store";
import { getRpcSession, startRpcSession, type AgentSessionWrapper, type RpcSessionStartOptions } from "./rpc-manager";
import { listRooms } from "./room-store";
import { readSessionHeader, resolveSessionPath } from "./session-reader";
import type { TeamAgentProfile } from "./team-types";
import { isProjectlessChatCwd } from "./projectless-chat-path";
import { getProjectlessChatWorkspace } from "./projectless-chat-server";

export type SessionRuntimeResolverErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_FILE_INVALID"
  | "SESSION_PROFILE_MISMATCH"
  | "RUNTIME_START_FAILED"
  | "INVALID_SESSION_ID";

export class SessionRuntimeResolverError extends Error {
  constructor(
    readonly code: SessionRuntimeResolverErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SessionRuntimeResolverError";
  }
}
export interface ResolveOrStartRpcSessionOptions {
  runtimeProfile?: AgentRuntimeProfile;
  startOptions?: Omit<RpcSessionStartOptions, "runtimeProfile">;
}

function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 512 || /[\u0000-\u001f]/.test(sessionId)) {
    throw new SessionRuntimeResolverError("INVALID_SESSION_ID", "A valid session id is required.");
  }
}

export function managedTeamStartOptions(
  profile: TeamAgentProfile,
  base: Omit<RpcSessionStartOptions, "runtimeProfile"> = {},
): Omit<RpcSessionStartOptions, "runtimeProfile"> {
  return {
    ...base,
    ...(profile.toolPolicy.mode === "allowlist"
      ? { toolNames: [...new Set([...profile.toolPolicy.toolNames, "piora_room"])] }
      : {}),
    ...(profile.modelPolicy.mode === "pinned" ? {
      initialModel: { provider: profile.modelPolicy.provider, modelId: profile.modelPolicy.modelId },
      thinkingLevel: profile.modelPolicy.thinkingLevel,
    } : {}),
  };
}

/**
 * Resolve the authoritative session file/cwd/profile and, when necessary,
 * restore one AgentSession. Callers never provide a substitute path or cwd.
 */
export async function resolveOrStartRpcSession(
  sessionId: string,
  options: ResolveOrStartRpcSessionOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string; sessionFile?: string; cwd: string }> {
  assertSessionId(sessionId);
  const runtimeProfile = options.runtimeProfile ?? getAgentRuntimeProfile();
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) {
    try {
      await resolveSessionAgentRuntimeProfile(sessionId, runtimeProfile);
    } catch (error) {
      throw new SessionRuntimeResolverError(
        "SESSION_PROFILE_MISMATCH",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    if (live.runtimeProfile !== runtimeProfile) {
      throw new SessionRuntimeResolverError(
        "SESSION_PROFILE_MISMATCH",
        `Live session ${sessionId} has a mismatched runtime profile.`,
      );
    }
    return { session: live, realSessionId: live.sessionId, sessionFile: live.sessionFile || undefined, cwd: live.cwd };
  }

  const managedMember = listRooms(sessionId)
    .flatMap((room) => room.members)
    .find((member) => member.binding.sessionId === sessionId && member.binding.managedByPiora);

  const sessionFile = await resolveSessionPath(sessionId);
  if (!sessionFile) {
    throw new SessionRuntimeResolverError("SESSION_NOT_FOUND", `Session ${sessionId} was not found.`);
  }
  const header = (() => {
    try { return readSessionHeader(sessionFile); } catch (error) {
      throw new SessionRuntimeResolverError("SESSION_FILE_INVALID", `Session ${sessionId} could not be read.`, { cause: error });
    }
  })();
  if (!header || header.id !== sessionId || typeof header.cwd !== "string" || !header.cwd.trim()) {
    throw new SessionRuntimeResolverError("SESSION_FILE_INVALID", `Session ${sessionId} has an invalid session header.`);
  }

  try {
    await resolveSessionAgentRuntimeProfile(sessionId, runtimeProfile);
  } catch (error) {
    throw new SessionRuntimeResolverError(
      "SESSION_PROFILE_MISMATCH",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  try {
    const runtimeCwd = isProjectlessChatCwd(header.cwd)
      ? getProjectlessChatWorkspace()
      : header.cwd;
    const startOptions = managedMember
      ? managedTeamStartOptions(managedMember.profile, options.startOptions)
      : options.startOptions;
    const started = await startRpcSession(sessionId, sessionFile, runtimeCwd, {
      ...startOptions,
      runtimeProfile,
    });
    if (started.realSessionId !== sessionId) {
      throw new SessionRuntimeResolverError(
        "RUNTIME_START_FAILED",
        `Restored session id ${started.realSessionId} does not match requested session ${sessionId}.`,
      );
    }
    await started.session.waitUntilReady();
    // Tool activation and the selected model are runtime-only SDK state.
    // Restore the managed Profile before admitting the first Team prompt.
    if (managedMember?.profile.modelPolicy.mode === "pinned") {
      await started.session.send({
        type: "set_model",
        provider: managedMember.profile.modelPolicy.provider,
        modelId: managedMember.profile.modelPolicy.modelId,
      });
      await started.session.send({ type: "set_thinking_level", level: managedMember.profile.modelPolicy.thinkingLevel });
    }
    if (managedMember?.profile.toolPolicy.mode === "allowlist") {
      await started.session.send({ type: "set_team_tools", toolNames: managedMember.profile.toolPolicy.toolNames });
    }
    return { ...started, sessionFile, cwd: runtimeCwd };
  } catch (error) {
    if (error instanceof SessionRuntimeResolverError) throw error;
    throw new SessionRuntimeResolverError(
      "RUNTIME_START_FAILED",
      `Failed to start session ${sessionId}.`,
      { cause: error },
    );
  }
}
