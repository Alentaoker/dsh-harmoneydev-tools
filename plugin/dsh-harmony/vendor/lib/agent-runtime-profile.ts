export const AGENT_RUNTIME_PROFILES = ["normal", "device-control"] as const;

export type AgentRuntimeProfile = (typeof AGENT_RUNTIME_PROFILES)[number];

export interface AgentRuntimeProfileEnvironment {
  readonly [key: string]: string | undefined;
  PIORA_RUNTIME_PROFILE?: string;
}

export class AgentRuntimeProfileError extends Error {
  readonly code: "INVALID_RUNTIME_PROFILE" | "RUNTIME_PROFILE_CHANGED" | "RUNTIME_PROFILE_MISMATCH";

  constructor(
    code: "INVALID_RUNTIME_PROFILE" | "RUNTIME_PROFILE_CHANGED" | "RUNTIME_PROFILE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "AgentRuntimeProfileError";
    this.code = code;
  }
}

export function parseAgentRuntimeProfile(
  environment: AgentRuntimeProfileEnvironment = process.env,
): AgentRuntimeProfile {
  const configured = environment.PIORA_RUNTIME_PROFILE;
  if (configured === undefined || configured.trim() === "") return "normal";
  if (configured === "normal" || configured === "device-control") return configured;
  throw new AgentRuntimeProfileError(
    "INVALID_RUNTIME_PROFILE",
    `PIORA_RUNTIME_PROFILE must be "normal" or "device-control"; received ${JSON.stringify(configured)}.`,
  );
}

declare global {
  var __pioraAgentRuntimeProfile: AgentRuntimeProfile | undefined;
}

/**
 * Resolve the process-wide cold-start profile. Changing the environment after
 * the first lookup is treated as a security error rather than silently
 * switching a live AgentSession between privilege sets.
 */
export function getAgentRuntimeProfile(
  environment: AgentRuntimeProfileEnvironment = process.env,
): AgentRuntimeProfile {
  const current = parseAgentRuntimeProfile(environment);
  const bootProfile = globalThis.__pioraAgentRuntimeProfile;
  if (bootProfile === undefined) {
    globalThis.__pioraAgentRuntimeProfile = current;
    return current;
  }
  if (bootProfile !== current) {
    throw new AgentRuntimeProfileError(
      "RUNTIME_PROFILE_CHANGED",
      `The Agent runtime profile was ${bootProfile} at process startup and cannot change to ${current}.`,
    );
  }
  return bootProfile;
}

export function assertCurrentAgentRuntimeProfile(profile: AgentRuntimeProfile): void {
  const current = getAgentRuntimeProfile();
  if (profile !== current) {
    throw new AgentRuntimeProfileError(
      "RUNTIME_PROFILE_MISMATCH",
      `Session runtime profile ${profile} cannot run in the ${current} process.`,
    );
  }
}

/** Test-only reset for isolated module tests. Never call from application code. */
export function resetAgentRuntimeProfileForTests(): void {
  globalThis.__pioraAgentRuntimeProfile = undefined;
}
