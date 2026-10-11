import { createHash, timingSafeEqual } from "node:crypto";
import type { PromptRunIdentity, PromptToolIdentity } from "./prompt-run-registry";
import { registerPromptRunCleanup, requirePromptToolIdentity } from "./prompt-run-registry";
import { getRoom } from "./room-store";
import { getTeamRun } from "./team-run-store";
import { TeamError } from "./team-errors";
import type { TeamExecutionContext } from "./team-types";

interface TeamPromptRecord {
  promptRun: PromptRunIdentity;
  context: TeamExecutionContext;
  removeCleanup: () => void;
}

export interface TeamToolIdentity extends PromptToolIdentity {
  context: TeamExecutionContext;
}

declare global {
  var __pioraTeamPromptContexts: Map<string, TeamPromptRecord> | undefined;
}

function contexts(): Map<string, TeamPromptRecord> {
  return globalThis.__pioraTeamPromptContexts ??= new Map();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function validateTeamExecutionContext(context: TeamExecutionContext, targetSessionId: string): void {
  if (!context || context.schemaVersion !== 1 || context.attempt < 1 || context.memberId.length === 0) {
    throw new TeamError("TEAM_INVALID_CONTEXT", "Team execution context is invalid.");
  }
  const room = getRoom(context.roomId);
  const member = room.members.find((candidate) => candidate.memberId === context.memberId);
  if (!member || member.binding.sessionId !== targetSessionId || member.profile.revision !== context.profileRevision || member.binding.status !== "ready") {
    throw new TeamError("TEAM_INVALID_CONTEXT", "Team Agent binding no longer matches this dispatch.");
  }
  const state = getTeamRun(context.roomId, context.teamRunId);
  const dispatch = state.activeDispatches[context.dispatchId];
  if (!dispatch || dispatch.taskId !== context.taskId || dispatch.memberId !== context.memberId
    || dispatch.sessionId !== targetSessionId || dispatch.attempt !== context.attempt || dispatch.purpose !== context.purpose
    || !["requested", "accepted", "queued", "running"].includes(dispatch.status)) {
    throw new TeamError("TEAM_INVALID_CONTEXT", "Team dispatch is no longer active or does not match this command.");
  }
  if (!safeHashEqual(tokenHash(context.leaseToken), dispatch.leaseTokenHash)) {
    throw new TeamError("TEAM_LEASE_INVALID", "Team execution lease is invalid.");
  }
}

export function bindTeamPromptContext(promptRun: PromptRunIdentity, context: TeamExecutionContext): void {
  if (promptRun.sessionId.length === 0) throw new TeamError("TEAM_INVALID_CONTEXT", "PromptRun session is missing.");
  validateTeamExecutionContext(context, promptRun.sessionId);
  if (contexts().has(promptRun.sessionId)) throw new TeamError("TEAM_INVALID_CONTEXT", "This Session already has an active Team prompt context.");
  const copy = structuredClone(context);
  const removeCleanup = registerPromptRunCleanup(promptRun, () => finishTeamPromptContext(promptRun));
  contexts().set(promptRun.sessionId, { promptRun: { ...promptRun }, context: copy, removeCleanup });
}

export function getActiveTeamPromptContext(sessionId: string): TeamExecutionContext | undefined {
  const record = contexts().get(sessionId);
  return record ? structuredClone(record.context) : undefined;
}

export function requireTeamToolContext(sessionId: string, toolCallId: string): TeamToolIdentity {
  const prompt = requirePromptToolIdentity(sessionId, toolCallId);
  const record = contexts().get(sessionId);
  if (!record || record.promptRun.runId !== prompt.runId) {
    throw new TeamError("TEAM_INVALID_CONTEXT", "Team tool action is not attached to an active Team prompt.");
  }
  validateTeamExecutionContext(record.context, sessionId);
  return { ...prompt, context: structuredClone(record.context) };
}

export function finishTeamPromptContext(promptRun: PromptRunIdentity): void {
  const record = contexts().get(promptRun.sessionId);
  if (!record || record.promptRun.runId !== promptRun.runId) return;
  contexts().delete(promptRun.sessionId);
  record.removeCleanup();
}

export function activeTeamPromptContextCount(): number {
  return contexts().size;
}

export function resetTeamPromptContextsForTests(): void {
  for (const record of contexts().values()) record.removeCleanup();
  contexts().clear();
}
