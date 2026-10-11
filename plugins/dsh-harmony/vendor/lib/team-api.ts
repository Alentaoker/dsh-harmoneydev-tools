import { InvalidJsonBodyError, JsonBodyTooLargeError } from "./bounded-json";
import { asTeamError, isTeamError } from "./team-errors";

export function teamApiError(error: unknown): Response {
  if (error instanceof JsonBodyTooLargeError) return Response.json({ error: { code: "TEAM_INPUT_TOO_LARGE", message: error.message } }, { status: 413 });
  if (error instanceof InvalidJsonBodyError) return Response.json({ error: { code: "TEAM_INVALID_INPUT", message: error.message } }, { status: 400 });
  const team = isTeamError(error) ? error : asTeamError(error);
  return Response.json({ error: { code: team.code, message: team.message, ...(team.details ? { details: team.details } : {}) } }, { status: team.status });
}
