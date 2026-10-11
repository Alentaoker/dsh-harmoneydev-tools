export type TeamErrorCode =
  | "TEAM_INVALID_INPUT"
  | "TEAM_INPUT_TOO_LARGE"
  | "TEAM_ROOM_NOT_FOUND"
  | "TEAM_RUN_NOT_FOUND"
  | "TEAM_TASK_NOT_FOUND"
  | "TEAM_MEMBER_NOT_FOUND"
  | "TEAM_REVISION_CONFLICT"
  | "TEAM_INVALID_TRANSITION"
  | "TEAM_INVALID_PLAN"
  | "TEAM_INVALID_CONTEXT"
  | "TEAM_LEASE_INVALID"
  | "TEAM_REVIEW_REQUIRED"
  | "TEAM_EVIDENCE_REQUIRED"
  | "TEAM_CAPABILITY_UNAVAILABLE"
  | "TEAM_CONCURRENCY_LIMIT"
  | "TEAM_WORKSPACE_CONFLICT"
  | "TEAM_EVENT_LOG_CORRUPT"
  | "TEAM_CAPACITY_EXCEEDED"
  | "TEAM_ALREADY_TERMINAL"
  | "TEAM_INTERNAL_ERROR";

const STATUS_BY_CODE: Record<TeamErrorCode, number> = {
  TEAM_INVALID_INPUT: 400,
  TEAM_INPUT_TOO_LARGE: 413,
  TEAM_ROOM_NOT_FOUND: 404,
  TEAM_RUN_NOT_FOUND: 404,
  TEAM_TASK_NOT_FOUND: 404,
  TEAM_MEMBER_NOT_FOUND: 404,
  TEAM_REVISION_CONFLICT: 409,
  TEAM_INVALID_TRANSITION: 409,
  TEAM_INVALID_PLAN: 422,
  TEAM_INVALID_CONTEXT: 403,
  TEAM_LEASE_INVALID: 409,
  TEAM_REVIEW_REQUIRED: 409,
  TEAM_EVIDENCE_REQUIRED: 409,
  TEAM_CAPABILITY_UNAVAILABLE: 409,
  TEAM_CONCURRENCY_LIMIT: 409,
  TEAM_WORKSPACE_CONFLICT: 409,
  TEAM_EVENT_LOG_CORRUPT: 500,
  TEAM_CAPACITY_EXCEEDED: 409,
  TEAM_ALREADY_TERMINAL: 409,
  TEAM_INTERNAL_ERROR: 500,
};

export class TeamError extends Error {
  readonly code: TeamErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: TeamErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TeamError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function isTeamError(error: unknown): error is TeamError {
  return error instanceof TeamError;
}

export function asTeamError(error: unknown): TeamError {
  if (isTeamError(error)) return error;
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof candidate.code === "string" && candidate.code in STATUS_BY_CODE) {
      return new TeamError(
        candidate.code as TeamErrorCode,
        typeof candidate.message === "string" ? candidate.message : "Team runtime failed.",
        candidate.details && typeof candidate.details === "object" ? candidate.details as Record<string, unknown> : undefined,
      );
    }
  }
  return new TeamError("TEAM_INTERNAL_ERROR", error instanceof Error ? error.message : "Team runtime failed.");
}
