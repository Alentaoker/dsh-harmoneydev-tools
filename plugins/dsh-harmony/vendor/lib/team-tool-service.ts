import { randomUUID } from "node:crypto";
import { getTeamCoordinatorService } from "./team-coordinator-service";
import { requireTeamToolContext } from "./team-prompt-context";
import { getRoom, publishRoomArtifact } from "./room-store";
import { validateTeamPlan } from "./team-run-reducer";
import { getTeamRunStore } from "./team-run-store";
import { TeamError } from "./team-errors";
import type { AppendTeamEventInput, TeamPlan, TeamReviewDecision, TeamRunState, TeamTask } from "./team-types";

export interface SubmitPlanInput {
  objective: string;
  assumptions: string[];
  successCriteria: Array<{ id: string; description: string; required?: boolean }>;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    requiredCapabilities: string[];
    dependsOn: string[];
    priority?: number;
    preferredMemberId?: string;
    reviewRequired?: boolean;
  }>;
}

function reconcileAfterMutation(roomId: string, runId: string, reason: "plan_submitted" | "task_changed" | "review_changed"): Promise<TeamRunState> {
  return getTeamCoordinatorService().reconcile(roomId, runId, reason);
}

async function appendLatestTeamEvents(
  roomId: string,
  teamRunId: string,
  createEvents: (state: TeamRunState) => readonly AppendTeamEventInput[],
): Promise<TeamRunState> {
  let conflict: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = getTeamRunStore().getTeamRun(roomId, teamRunId);
    try {
      return await getTeamRunStore().appendTeamRunEvents(roomId, teamRunId, state.revision, createEvents(state));
    } catch (error) {
      if (!(error instanceof TeamError) || error.code !== "TEAM_REVISION_CONFLICT") throw error;
      conflict = error;
    }
  }
  throw conflict;
}

export function getTeamAssignment(sessionId: string, toolCallId: string) {
  const identity = requireTeamToolContext(sessionId, toolCallId);
  const state = getTeamRunStore().getTeamRun(identity.context.roomId, identity.context.teamRunId);
  return { context: { ...identity.context, leaseToken: undefined }, run: state, task: state.tasks[identity.context.taskId] };
}

export async function submitTeamPlan(sessionId: string, toolCallId: string, input: SubmitPlanInput) {
  const { context } = requireTeamToolContext(sessionId, toolCallId);
  if (context.purpose !== "planning" && context.purpose !== "replan") throw new TeamError("TEAM_INVALID_CONTEXT", "This prompt cannot submit a Team plan.");
  const room = getRoom(context.roomId);
  const member = room.members.find((candidate) => candidate.memberId === context.memberId)!;
  if (member.profile.role !== "coordinator" && member.profile.role !== "planner") throw new TeamError("TEAM_INVALID_CONTEXT", "Only a Coordinator or Planner can submit a plan.");
  let state = getTeamRunStore().getTeamRun(context.roomId, context.teamRunId);
  const now = Date.now();
  const slugMap = new Map(input.tasks.map((task) => [task.id, `${state.id}:${task.id}`]));
  if (slugMap.size !== input.tasks.length) throw new TeamError("TEAM_INVALID_PLAN", "Task slugs must be unique.");
  const tasks: TeamTask[] = input.tasks.map((item) => {
    const reviewRequired = item.reviewRequired ?? (room.coordination.requireReviewForCodeChanges && room.coordination.defaultReviewerMemberIds.length > 0);
    return ({
    schemaVersion: 1,
    id: slugMap.get(item.id)!,
    teamRunId: state.id,
    title: item.title,
    description: item.description,
    acceptanceCriteria: item.acceptanceCriteria,
    requiredCapabilities: item.requiredCapabilities.map((capability) => capability.trim().toLowerCase()),
    dependsOn: item.dependsOn.map((dependency) => slugMap.get(dependency) ?? dependency),
    priority: Math.max(-100, Math.min(100, Math.floor(item.priority ?? 0))),
    status: "pending",
    assignmentMode: "auto",
    ...(item.preferredMemberId ? { preferredMemberId: item.preferredMemberId } : {}),
    attempt: 0,
    maxAttempts: room.coordination.maxTaskAttempts,
    reviewPolicy: {
      required: reviewRequired,
      reviewerMemberIds: reviewRequired ? [...room.coordination.defaultReviewerMemberIds] : [],
      minimumApprovals: reviewRequired ? 1 : 0,
    },
    reviewRound: 0,
    createdAt: now,
    updatedAt: now,
    });
  });
  const plan: TeamPlan = {
    schemaVersion: 1,
    revision: 1,
    objective: state.objective,
    assumptions: input.assumptions,
    successCriteria: input.successCriteria.map((criterion) => ({ ...criterion, required: criterion.required ?? true, status: "pending", evidenceIds: [] })),
    taskIds: tasks.map((task) => task.id),
    submittedByMemberId: context.memberId,
    createdAt: now,
    updatedAt: now,
  };
  validateTeamPlan(plan, room, tasks, state.id);
  state = await appendLatestTeamEvents(state.roomId, state.id, () => [
    { event: { type: "plan.submitted", plan, tasks }, actor: { kind: "member", memberId: context.memberId, sessionId } },
    { event: { type: "run.started" }, actor: { kind: "system", id: "piora" } },
  ]);
  return reconcileAfterMutation(state.roomId, state.id, "plan_submitted");
}

export async function reportTeamProgress(sessionId: string, toolCallId: string, progress: string) {
  const { context } = requireTeamToolContext(sessionId, toolCallId);
  if (context.purpose !== "task") throw new TeamError("TEAM_INVALID_CONTEXT", "Only a task execution can report task progress.");
  const room = getRoom(context.roomId);
  return appendLatestTeamEvents(context.roomId, context.teamRunId, () => [{
    event: { type: "task.heartbeat", taskId: context.taskId, dispatchId: context.dispatchId, expiresAt: Date.now() + room.coordination.leaseDurationMs, progress },
    actor: { kind: "member", memberId: context.memberId, sessionId },
  }]);
}

export async function addTeamEvidence(sessionId: string, toolCallId: string, input: { kind?: "verification" | "observation" | "review" | "integration"; summary: string }) {
  const { context } = requireTeamToolContext(sessionId, toolCallId);
  if (input.kind === "verification") throw new TeamError("TEAM_INVALID_CONTEXT", "Runtime verification cannot be declared by the model.");
  let state = getTeamRunStore().getTeamRun(context.roomId, context.teamRunId);
  const evidence = {
    id: randomUUID(), teamRunId: state.id, taskId: context.taskId, memberId: context.memberId,
    kind: input.kind ?? "observation", summary: input.summary, source: "model", createdAt: Date.now(),
  } as const;
  state = await appendLatestTeamEvents(state.roomId, state.id, () => [{
    event: { type: "task.evidence_added", taskId: context.taskId, evidence }, actor: { kind: "member", memberId: context.memberId, sessionId },
  }]);
  return { state, evidence };
}

export async function publishTeamArtifact(sessionId: string, toolCallId: string, input: { kind: "patch" | "commit" | "report" | "file"; name: string; summary: string; sourcePath?: string }) {
  const { context } = requireTeamToolContext(sessionId, toolCallId);
  if (context.purpose !== "task") throw new TeamError("TEAM_INVALID_CONTEXT", "Only the current task assignee can publish task artifacts.");
  let state = getTeamRunStore().getTeamRun(context.roomId, context.teamRunId);
  if (input.kind === "commit" && !/^[0-9a-f]{7,64}$/iu.test(input.name)) {
    throw new TeamError("TEAM_INVALID_INPUT", "Commit artifacts must use a verified Git commit hash as their name.");
  }
  const stored = publishRoomArtifact(context.roomId, sessionId, { kind: input.kind, name: input.name, summary: input.summary, sourcePath: input.sourcePath });
  const artifact = {
    id: stored.id, roomId: state.roomId, teamRunId: state.id, taskId: context.taskId, memberId: context.memberId,
    kind: input.kind, name: stored.name, summary: stored.summary, sourcePath: stored.sourcePath, storedPath: stored.storedPath,
    ...(input.kind === "commit" && stored.worktree?.branch ? { commit: { hash: input.name, branch: stored.worktree.branch } } : {}),
    createdAt: stored.createdAt,
  };
  state = await appendLatestTeamEvents(state.roomId, state.id, () => [{
    event: { type: "task.artifact_added", taskId: context.taskId, artifact }, actor: { kind: "member", memberId: context.memberId, sessionId },
  }]);
  return { state, artifact };
}

export async function submitTeamTask(sessionId: string, toolCallId: string, input: { summary: string; evidenceIds: string[]; artifactIds: string[] }) {
  const { context } = requireTeamToolContext(sessionId, toolCallId);
  if (context.purpose !== "task") throw new TeamError("TEAM_INVALID_CONTEXT", "Only the current task execution can submit a task.");
  let state = getTeamRunStore().getTeamRun(context.roomId, context.teamRunId);
  state = await appendLatestTeamEvents(state.roomId, state.id, () => [{
    event: { type: "task.submitted", taskId: context.taskId, submission: { ...input, submittedAt: Date.now() } },
    actor: { kind: "member", memberId: context.memberId, sessionId },
  }]);
  return reconcileAfterMutation(state.roomId, state.id, "task_changed");
}

export async function settleTeamTask(sessionId: string, toolCallId: string, input: { status: "blocked" | "failed"; reason: string; retryable?: boolean }) {
  const { context } = requireTeamToolContext(sessionId, toolCallId);
  if (context.purpose !== "task") throw new TeamError("TEAM_INVALID_CONTEXT", "Only the current task execution can settle a task.");
  let state = getTeamRunStore().getTeamRun(context.roomId, context.teamRunId);
  const task = state.tasks[context.taskId];
  if (!task) throw new TeamError("TEAM_TASK_NOT_FOUND", "Team task was not found.");
  const events: AppendTeamEventInput[] = [{
    event: input.status === "blocked"
      ? { type: "task.blocked", taskId: context.taskId, reason: input.reason } as const
      : { type: "task.failed", taskId: context.taskId, reason: input.reason, retryable: input.retryable ?? false } as const,
    actor: { kind: "member", memberId: context.memberId, sessionId } as const,
  }];
  if (input.status === "failed" && input.retryable === true && task.attempt < task.maxAttempts) {
    events.push({ event: { type: "task.requeued", taskId: context.taskId, reason: "Agent requested a retry after a retryable failure." }, actor: { kind: "system", id: "piora" } });
  }
  state = await appendLatestTeamEvents(state.roomId, state.id, () => events);
  return reconcileAfterMutation(state.roomId, state.id, "task_changed");
}

export async function submitTeamReview(sessionId: string, toolCallId: string, input: Omit<TeamReviewDecision, "id" | "teamRunId" | "taskId" | "reviewerMemberId" | "round" | "createdAt">) {
  const { context } = requireTeamToolContext(sessionId, toolCallId);
  if (context.purpose !== "review") throw new TeamError("TEAM_INVALID_CONTEXT", "Only a review dispatch can submit a review.");
  let state = getTeamRunStore().getTeamRun(context.roomId, context.teamRunId);
  const task = state.tasks[context.taskId];
  if (!task) throw new TeamError("TEAM_TASK_NOT_FOUND", "Review task was not found.");
  const decision: TeamReviewDecision = {
    id: randomUUID(), teamRunId: state.id, taskId: task.id, reviewerMemberId: context.memberId,
    round: task.reviewRound, verdict: input.verdict, summary: input.summary, findings: input.findings,
    evidenceIds: input.evidenceIds, createdAt: Date.now(),
  };
  state = await appendLatestTeamEvents(state.roomId, state.id, () => [{
    event: { type: "task.review_submitted", taskId: task.id, decision }, actor: { kind: "member", memberId: context.memberId, sessionId },
  }]);
  return reconcileAfterMutation(state.roomId, state.id, "review_changed");
}

export async function completeTeamRun(sessionId: string, toolCallId: string, input: { summary: string; finalArtifactIds: string[]; successCriteriaEvidence: Record<string, string[]> }) {
  const { context } = requireTeamToolContext(sessionId, toolCallId);
  if (context.purpose !== "synthesis") throw new TeamError("TEAM_INVALID_CONTEXT", "Only the synthesis dispatch can complete a TeamRun.");
  const state = getTeamRunStore().getTeamRun(context.roomId, context.teamRunId);
  if (state.coordinatorMemberId !== context.memberId) throw new TeamError("TEAM_INVALID_CONTEXT", "Only the Coordinator can complete a TeamRun.");
  await getTeamRunStore().appendTeamOutbox(state.roomId, state.id, {
    kind: "room_message",
    idempotencyKey: `team:${state.roomId}:${state.id}:final`,
    payload: { summary: input.summary, authorMemberId: context.memberId },
  });
  const completed = await appendLatestTeamEvents(state.roomId, state.id, () => [{
    event: { type: "run.completed", ...input }, actor: { kind: "member", memberId: context.memberId, sessionId },
  }]);
  await getTeamCoordinatorService().deliverPendingOutbox(completed.roomId, completed.id);
  return completed;
}
