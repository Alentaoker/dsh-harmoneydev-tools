import type { TaskRunPhase, TaskRunState } from "./task-run";
import { TeamError } from "./team-errors";
import {
  TEAM_DEFAULTS,
  TEAM_RUN_SCHEMA_VERSION,
  type CollaborationRoomV3,
  type TeamArtifactReference,
  type TeamDispatchState,
  type TeamPlan,
  type TeamReviewDecision,
  type TeamRunEvent,
  type TeamRunEventEnvelope,
  type TeamRunPhase,
  type TeamRunState,
  type TeamTask,
  type TeamTaskStatus,
} from "./team-types";

const TERMINAL_RUN_PHASES = new Set<TeamRunPhase>(["completed", "failed", "cancelled"]);
const TERMINAL_TASK_STATUSES = new Set<TeamTaskStatus>(["completed", "failed", "cancelled", "skipped"]);
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/;

function fail(message: string, details?: Record<string, unknown>): never {
  throw new TeamError("TEAM_INVALID_TRANSITION", message, details);
}

function requireText(value: string, label: string, maxBytes: number): string {
  const cleaned = value.trim();
  if (!cleaned) throw new TeamError("TEAM_INVALID_INPUT", `${label} must not be empty.`);
  if (Buffer.byteLength(cleaned, "utf8") > maxBytes) {
    throw new TeamError("TEAM_INPUT_TOO_LARGE", `${label} exceeds its UTF-8 byte limit.`, { maxBytes });
  }
  return cleaned;
}

function copyState(state: TeamRunState): TeamRunState {
  return structuredClone(state);
}

function requireTask(state: TeamRunState, taskId: string): TeamTask {
  const task = state.tasks[taskId];
  if (!task) throw new TeamError("TEAM_TASK_NOT_FOUND", "Team task was not found.", { taskId });
  return task;
}

function requireTaskStatus(task: TeamTask, allowed: readonly TeamTaskStatus[], eventType: string): void {
  if (!allowed.includes(task.status)) {
    fail(`Cannot apply ${eventType} while task ${task.id} is ${task.status}.`, { taskId: task.id, status: task.status });
  }
}

function requireDispatch(state: TeamRunState, dispatchId: string, taskId?: string): TeamDispatchState {
  const dispatch = state.activeDispatches[dispatchId];
  if (!dispatch || (taskId && dispatch.taskId !== taskId)) {
    throw new TeamError("TEAM_INVALID_CONTEXT", "Team dispatch does not match the active task context.");
  }
  return dispatch;
}

function validateTaskShape(task: TeamTask, runId: string): void {
  if (!TASK_ID_PATTERN.test(task.id) || task.id.startsWith("__")) {
    throw new TeamError("TEAM_INVALID_PLAN", `Invalid task id: ${task.id}.`);
  }
  if (task.teamRunId !== runId) throw new TeamError("TEAM_INVALID_PLAN", `Task ${task.id} targets another run.`);
  requireText(task.title, `Task ${task.id} title`, 240 * 4);
  requireText(task.description, `Task ${task.id} description`, 64 * 1024);
  if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0
    || task.acceptanceCriteria.some((criterion) => !criterion.trim())) {
    throw new TeamError("TEAM_INVALID_PLAN", `Task ${task.id} requires non-empty acceptance criteria.`);
  }
  if (!Number.isInteger(task.attempt) || task.attempt < 0 || !Number.isInteger(task.maxAttempts) || task.maxAttempts < 1) {
    throw new TeamError("TEAM_INVALID_PLAN", `Task ${task.id} has invalid attempt limits.`);
  }
  if (task.attempt > task.maxAttempts) throw new TeamError("TEAM_INVALID_PLAN", `Task ${task.id} exceeds maxAttempts.`);
  if (task.reviewPolicy.minimumApprovals < 0
    || task.reviewPolicy.minimumApprovals > task.reviewPolicy.reviewerMemberIds.length
    || (task.reviewPolicy.required && task.reviewPolicy.minimumApprovals < 1)) {
    throw new TeamError("TEAM_INVALID_PLAN", `Task ${task.id} has an invalid review policy.`);
  }
}

export interface ValidatedTeamPlan {
  plan: TeamPlan;
  tasks: TeamTask[];
  topologicalTaskIds: string[];
}

function resolvePlanTasks(plan: TeamPlan, tasks: readonly TeamTask[]): TeamTask[] {
  const actualTasks = tasks.length > 0
    ? [...tasks]
    : plan.taskIds.map((id) => { throw new TeamError("TEAM_INVALID_PLAN", `Task definition is missing for ${id}.`); });
  if (actualTasks.length === 0 || actualTasks.length > TEAM_DEFAULTS.maxTasks) {
    throw new TeamError("TEAM_INVALID_PLAN", `A Team plan must contain 1-${TEAM_DEFAULTS.maxTasks} tasks.`);
  }
  return actualTasks;
}

function validatePlanMembersAndTasks(
  plan: TeamPlan,
  tasks: readonly TeamTask[],
  room: Pick<CollaborationRoomV3, "members">,
  runId?: string,
): Set<string> {
  const memberIds = new Set(room.members.map((member) => member.memberId));
  if (!memberIds.has(plan.submittedByMemberId)) throw new TeamError("TEAM_MEMBER_NOT_FOUND", "Plan submitter is not a room member.");
  const taskIds = new Set<string>();
  for (const task of tasks) {
    validateTaskShape(task, runId ?? task.teamRunId);
    if (taskIds.has(task.id)) throw new TeamError("TEAM_INVALID_PLAN", `Duplicate task id: ${task.id}.`);
    taskIds.add(task.id);
    if (task.preferredMemberId && !memberIds.has(task.preferredMemberId)) {
      throw new TeamError("TEAM_MEMBER_NOT_FOUND", `Preferred member for ${task.id} is not in the room.`);
    }
    for (const reviewerId of task.reviewPolicy.reviewerMemberIds) {
      if (!memberIds.has(reviewerId)) throw new TeamError("TEAM_MEMBER_NOT_FOUND", `Reviewer for ${task.id} is not in the room.`);
      if (reviewerId === task.preferredMemberId) throw new TeamError("TEAM_INVALID_PLAN", `Task ${task.id} cannot be reviewed by its preferred assignee.`);
    }
  }
  return taskIds;
}

function topologicalTaskOrder(tasks: readonly TeamTask[], taskIds: ReadonlySet<string>): string[] {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const task of tasks) {
    const dependencies = new Set(task.dependsOn);
    if (dependencies.size !== task.dependsOn.length) throw new TeamError("TEAM_INVALID_PLAN", `Task ${task.id} contains duplicate dependencies.`);
    if (dependencies.has(task.id)) throw new TeamError("TEAM_INVALID_PLAN", `Task ${task.id} cannot depend on itself.`);
    for (const dependencyId of dependencies) {
      if (!taskIds.has(dependencyId)) throw new TeamError("TEAM_INVALID_PLAN", `Task ${task.id} has unknown dependency ${dependencyId}.`);
      outgoing.set(dependencyId, [...(outgoing.get(dependencyId) ?? []), task.id]);
    }
    indegree.set(task.id, dependencies.size);
  }
  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (ordered.length !== tasks.length) throw new TeamError("TEAM_INVALID_PLAN", "Team plan contains a dependency cycle.");
  return ordered;
}

function validateSuccessCriteria(plan: TeamPlan): void {
  const criterionIds = new Set<string>();
  for (const criterion of plan.successCriteria) {
    if (!criterion.id.trim() || !criterion.description.trim() || criterionIds.has(criterion.id)) {
      throw new TeamError("TEAM_INVALID_PLAN", "Success criteria require unique ids and descriptions.");
    }
    criterionIds.add(criterion.id);
  }
}

export function validateTeamPlan(
  plan: TeamPlan,
  room: Pick<CollaborationRoomV3, "members">,
  tasks: readonly TeamTask[] = [],
  runId?: string,
): ValidatedTeamPlan {
  requireText(plan.objective, "Team plan objective", TEAM_DEFAULTS.maxInputBytes);
  const actualTasks = resolvePlanTasks(plan, tasks);
  const taskIds = validatePlanMembersAndTasks(plan, actualTasks, room, runId);
  if (plan.taskIds.length !== actualTasks.length || plan.taskIds.some((id, index) => id !== actualTasks[index]?.id)) {
    throw new TeamError("TEAM_INVALID_PLAN", "Plan taskIds must exactly match the supplied task order.");
  }
  const ordered = topologicalTaskOrder(actualTasks, taskIds);
  validateSuccessCriteria(plan);
  return { plan: structuredClone(plan), tasks: structuredClone(actualTasks), topologicalTaskIds: ordered };
}

function validatePlanGraphWithoutRoom(plan: TeamPlan, tasks: readonly TeamTask[], runId: string): void {
  const memberIds = new Set<string>([plan.submittedByMemberId]);
  for (const task of tasks) {
    if (task.preferredMemberId) memberIds.add(task.preferredMemberId);
    for (const reviewerId of task.reviewPolicy.reviewerMemberIds) memberIds.add(reviewerId);
  }
  validateTeamPlan(plan, { members: [...memberIds].map((memberId) => ({ memberId })) as CollaborationRoomV3["members"] }, tasks, runId);
}

function updateDispatch(dispatch: TeamDispatchState, at: number, patch: Partial<TeamDispatchState>): void {
  Object.assign(dispatch, patch, { updatedAt: at });
}

function activeDispatchStatus(status: TeamDispatchState["status"]): boolean {
  return ["requested", "accepted", "queued", "running"].includes(status);
}

function taskHasRuntimeVerification(state: TeamRunState, task: TeamTask): boolean {
  return Object.values(state.evidence).some((evidence) => (
    evidence.taskId === task.id && evidence.source === "runtime" && evidence.kind === "verification" && evidence.exitCode !== undefined
      ? evidence.exitCode === 0
      : evidence.taskId === task.id && evidence.source === "runtime" && evidence.kind === "verification"
  ));
}

function taskNeedsRuntimeVerification(state: TeamRunState, task: TeamTask): boolean {
  return (task.submission?.artifactIds ?? []).some((id) => {
    const artifact = state.artifacts[id];
    return artifact?.kind === "patch" || artifact?.kind === "commit";
  });
}

function assertTaskCompletionGate(state: TeamRunState, task: TeamTask): void {
  if (!task.submission) throw new TeamError("TEAM_EVIDENCE_REQUIRED", "A structured task submission is required.");
  for (const id of task.submission.evidenceIds) {
    const evidence = state.evidence[id];
    if (!evidence || evidence.teamRunId !== state.id || evidence.taskId !== task.id || evidence.memberId !== task.assignedMemberId) {
      throw new TeamError("TEAM_EVIDENCE_REQUIRED", "Task submission references invalid evidence.");
    }
  }
  for (const id of task.submission.artifactIds) {
    const artifact = state.artifacts[id];
    if (!artifact || artifact.teamRunId !== state.id || artifact.taskId !== task.id || artifact.memberId !== task.assignedMemberId) {
      throw new TeamError("TEAM_INVALID_CONTEXT", "Task submission references an invalid artifact.");
    }
  }
  if (taskNeedsRuntimeVerification(state, task) && !taskHasRuntimeVerification(state, task)) {
    throw new TeamError("TEAM_EVIDENCE_REQUIRED", "Code-changing tasks require runtime verification evidence.");
  }
  if (task.reviewPolicy.required) {
    const decisions = Object.values(state.reviewDecisions).filter((decision) => (
      decision.taskId === task.id && decision.round === task.reviewRound && decision.verdict === "approved"
    ));
    if (decisions.some((decision) => decision.reviewerMemberId === task.assignedMemberId)) {
      throw new TeamError("TEAM_REVIEW_REQUIRED", "A worker cannot review their own task.");
    }
    if (decisions.some((decision) => decision.findings.some((finding) => finding.severity === "critical"))) {
      throw new TeamError("TEAM_REVIEW_REQUIRED", "Critical review findings must be resolved.");
    }
    if (new Set(decisions.map((decision) => decision.reviewerMemberId)).size < task.reviewPolicy.minimumApprovals) {
      throw new TeamError("TEAM_REVIEW_REQUIRED", "The task does not have enough independent approvals.");
    }
  }
}

export function deriveReadyTaskIds(state: TeamRunState): string[] {
  if (TERMINAL_RUN_PHASES.has(state.phase) || state.phase === "waiting_user" || state.phase === "synthesizing") return [];
  return Object.values(state.tasks)
    .filter((task) => task.status === "pending" && task.dependsOn.every((id) => state.tasks[id]?.status === "completed"))
    .sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((task) => task.id);
}

type MutableTeamRunEvent = Exclude<TeamRunEvent, { type: "run.created" }>;
type TeamEventHandlers = {
  [Type in MutableTeamRunEvent["type"]]: (
    state: TeamRunState,
    event: Extract<MutableTeamRunEvent, { type: Type }>,
    envelope: TeamRunEventEnvelope,
  ) => void;
};

const TEAM_EVENT_HANDLERS: TeamEventHandlers = {
  "planning.requested": (state, event) => {
    if (!["draft", "planning", "interrupted", "waiting_user"].includes(state.phase)) fail(`Cannot request planning while run is ${state.phase}.`);
    if (state.phase === "planning" && Object.values(state.activeDispatches).some((dispatch) => dispatch.purpose === "planning" && activeDispatchStatus(dispatch.status))) {
      fail("Cannot request planning while another planning dispatch is active.");
    }
    state.phase = "planning";
    state.waitingReason = undefined;
    state.activeDispatches[event.dispatch.dispatchId] = structuredClone(event.dispatch);
  },
  "plan.submitted": (state, event, envelope) => {
    if (state.phase !== "planning") fail(`Cannot submit a plan while run is ${state.phase}.`);
    validatePlanGraphWithoutRoom(event.plan, event.tasks, state.id);
    if (Object.keys(state.tasks).length > 0) fail("A plan has already populated this TeamRun.");
    state.plan = structuredClone(event.plan);
    state.tasks = Object.fromEntries(event.tasks.map((task) => [task.id, structuredClone(task)]));
    state.successCriteria = structuredClone(event.plan.successCriteria);
    for (const dispatch of Object.values(state.activeDispatches)) {
      if (dispatch.purpose === "planning" && activeDispatchStatus(dispatch.status)) updateDispatch(dispatch, envelope.at, { status: "completed" });
    }
  },
  "plan.rejected": (state, event) => {
    if (state.phase !== "planning") fail(`Cannot reject a plan while run is ${state.phase}.`);
    state.waitingReason = requireText(event.reason, "Plan rejection reason", 4_000);
  },
  "run.started": (state) => {
    if (state.phase !== "planning" || !state.plan) fail(`Cannot start run while it is ${state.phase}.`);
    state.phase = "running";
  },
  "run.progressed": (state, event) => {
    if (!["planning", "running", "reviewing", "integrating", "synthesizing"].includes(state.phase)) fail(`Cannot record progress while run is ${state.phase}.`);
    state.progressSummary = requireText(event.summary, "Progress summary", 8_000);
  },
  "run.waiting_user": (state, event) => {
    if (!["planning", "running", "reviewing", "integrating", "synthesizing"].includes(state.phase)) fail(`Cannot wait for user while run is ${state.phase}.`);
    state.phase = "waiting_user";
    state.waitingReason = requireText(event.reason, "Waiting reason", 8_000);
  },
  "run.resumed": (state, event, envelope) => {
    if (!["waiting_user", "interrupted"].includes(state.phase)) fail(`Cannot resume run while it is ${state.phase}.`);
    state.phase = state.plan ? "running" : "planning";
    state.retryGeneration = (state.retryGeneration ?? 0) + 1;
    state.waitingReason = undefined;
    for (const task of Object.values(state.tasks)) {
      if (!["blocked", "interrupted"].includes(task.status) || task.attempt >= task.maxAttempts) continue;
      task.status = "ready";
      task.assignedMemberId = undefined;
      task.assignedSessionId = undefined;
      task.submission = undefined;
      task.lease = undefined;
      task.updatedAt = envelope.at;
    }
  },
  "run.synthesis_requested": (state, event) => {
    if (!["running", "reviewing", "integrating", "synthesizing"].includes(state.phase)) fail(`Cannot synthesize while run is ${state.phase}.`);
    if (state.phase === "synthesizing" && Object.values(state.activeDispatches).some((dispatch) => dispatch.purpose === "synthesis" && activeDispatchStatus(dispatch.status))) {
      fail("Cannot request synthesis while another synthesis dispatch is active.");
    }
    if (Object.values(state.tasks).some((task) => !["completed", "skipped"].includes(task.status))) {
      fail("Cannot synthesize before all tasks are completed or skipped.");
    }
    state.phase = "synthesizing";
    state.activeDispatches[event.dispatch.dispatchId] = structuredClone(event.dispatch);
  },
  "run.completed": (state, event, envelope) => {
    if (state.phase !== "synthesizing") fail(`Cannot complete run while it is ${state.phase}.`);
    if (event.successCriteriaEvidence) {
      for (const criterion of state.successCriteria) {
        const ids = [...new Set(event.successCriteriaEvidence[criterion.id] ?? [])];
        if (ids.some((id) => !state.evidence[id])) throw new TeamError("TEAM_EVIDENCE_REQUIRED", `Success criterion ${criterion.id} references unknown evidence.`);
        criterion.evidenceIds = ids;
        criterion.status = ids.length > 0 ? "satisfied" : criterion.status;
      }
    }
    if (state.successCriteria.some((criterion) => criterion.required && criterion.status !== "satisfied")) {
      throw new TeamError("TEAM_EVIDENCE_REQUIRED", "Required success criteria are not satisfied.");
    }
    for (const artifactId of event.finalArtifactIds) if (!state.artifacts[artifactId]) throw new TeamError("TEAM_INVALID_CONTEXT", "Final result references an unknown artifact.");
    state.phase = "completed";
    state.finalSummary = requireText(event.summary, "Final summary", 64 * 1024);
    state.finalArtifactIds = [...new Set(event.finalArtifactIds)];
    state.finishedAt = envelope.at;
    for (const dispatch of Object.values(state.activeDispatches)) {
      if (activeDispatchStatus(dispatch.status)) updateDispatch(dispatch, envelope.at, { status: "completed" });
    }
    for (const task of Object.values(state.tasks)) task.lease = undefined;
  },
  "run.failed": (state, event, envelope) => {
    state.phase = "failed";
    state.waitingReason = requireText(event.reason, "Failure reason", 8_000);
    state.finishedAt = envelope.at;
    for (const dispatch of Object.values(state.activeDispatches)) {
      if (activeDispatchStatus(dispatch.status)) updateDispatch(dispatch, envelope.at, { status: "failed", errorCode: "TEAM_RUN_FAILED", errorMessage: state.waitingReason });
    }
    for (const task of Object.values(state.tasks)) task.lease = undefined;
  },
  "run.interrupted": (state, event, envelope) => {
    state.phase = "interrupted";
    state.waitingReason = requireText(event.reason, "Interruption reason", 8_000);
    for (const task of Object.values(state.tasks)) {
      if (!TERMINAL_TASK_STATUSES.has(task.status)) task.status = "interrupted";
      task.lease = undefined;
    }
    for (const dispatch of Object.values(state.activeDispatches)) {
      if (activeDispatchStatus(dispatch.status)) updateDispatch(dispatch, envelope.at, { status: "interrupted", errorCode: "TEAM_RUN_INTERRUPTED", errorMessage: state.waitingReason });
    }
  },
  "run.cancelled": (state, event, envelope) => {
    state.phase = "cancelled";
    state.waitingReason = requireText(event.reason, "Cancellation reason", 8_000);
    state.finishedAt = envelope.at;
    for (const task of Object.values(state.tasks)) {
      if (!TERMINAL_TASK_STATUSES.has(task.status)) task.status = "cancelled";
      task.lease = undefined;
    }
    for (const dispatch of Object.values(state.activeDispatches)) {
      if (activeDispatchStatus(dispatch.status)) updateDispatch(dispatch, envelope.at, { status: "interrupted", errorCode: "TEAM_RUN_CANCELLED", errorMessage: state.waitingReason });
    }
  },
  "task.created": (state, event) => {
    if (!["draft", "planning"].includes(state.phase)) fail(`Cannot create tasks while run is ${state.phase}.`);
    validateTaskShape(event.task, state.id);
    if (state.tasks[event.task.id]) fail(`Task ${event.task.id} already exists.`);
    state.tasks[event.task.id] = structuredClone(event.task);
  },
  "task.ready": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["pending"], event.type);
    if (!task.dependsOn.every((id) => state.tasks[id]?.status === "completed")) fail(`Task ${task.id} dependencies are incomplete.`);
    task.status = "ready";
    task.updatedAt = envelope.at;
  },
  "task.dispatch_requested": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["ready"], event.type);
    if (event.dispatch.taskId !== task.id || event.dispatch.attempt !== task.attempt + 1 || event.dispatch.leaseTokenHash !== event.leaseTokenHash) {
      throw new TeamError("TEAM_INVALID_CONTEXT", "Dispatch identity or attempt does not match the task.");
    }
    if (task.attempt >= task.maxAttempts) fail(`Task ${task.id} exhausted its attempts.`);
    task.status = "dispatching";
    task.attempt = event.dispatch.attempt;
    task.assignedMemberId = event.dispatch.memberId;
    task.assignedSessionId = event.dispatch.sessionId;
    task.lease = {
      tokenHash: event.leaseTokenHash,
      dispatchId: event.dispatch.dispatchId,
      holderMemberId: event.dispatch.memberId,
      holderSessionId: event.dispatch.sessionId,
      acquiredAt: envelope.at,
      heartbeatAt: envelope.at,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    task.updatedAt = envelope.at;
    state.activeDispatches[event.dispatch.dispatchId] = structuredClone(event.dispatch);
  },
  "task.dispatch_accepted": (state, event, envelope) => {
    const task = state.tasks[event.taskId];
    const dispatch = requireDispatch(state, event.dispatchId, event.taskId);
    if ((!task && event.taskId.startsWith("__")) || dispatch.purpose !== "task") {
      updateDispatch(dispatch, envelope.at, { status: "accepted", commandId: event.commandId });
      return;
    }
    if (!task) throw new TeamError("TEAM_TASK_NOT_FOUND", "Team task was not found.");
    requireTaskStatus(task, ["dispatching"], event.type);
    updateDispatch(dispatch, envelope.at, { status: "accepted", commandId: event.commandId });
    task.status = "queued";
    task.updatedAt = envelope.at;
  },
  "task.prompt_started": (state, event, envelope) => {
    const task = state.tasks[event.taskId];
    const dispatch = requireDispatch(state, event.dispatchId, event.taskId);
    if ((!task && event.taskId.startsWith("__")) || dispatch.purpose !== "task") {
      updateDispatch(dispatch, envelope.at, { status: "running", promptRunId: event.promptRunId });
      return;
    }
    if (!task) throw new TeamError("TEAM_TASK_NOT_FOUND", "Team task was not found.");
    requireTaskStatus(task, ["dispatching", "queued"], event.type);
    updateDispatch(dispatch, envelope.at, { status: "running", promptRunId: event.promptRunId });
    task.status = "running";
    if (!task.lease || task.lease.dispatchId !== dispatch.dispatchId) throw new TeamError("TEAM_LEASE_INVALID", "Task execution lease is missing.");
    task.lease.startedAt = envelope.at;
    task.lease.heartbeatAt = envelope.at;
    task.lease.expiresAt = envelope.at + TEAM_DEFAULTS.leaseDurationMs;
    task.updatedAt = envelope.at;
  },
  "task.heartbeat": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["running"], event.type);
    requireDispatch(state, event.dispatchId, task.id);
    if (!task.lease || event.expiresAt <= envelope.at) throw new TeamError("TEAM_LEASE_INVALID", "Heartbeat requires a future lease expiry.");
    task.lease.heartbeatAt = envelope.at;
    task.lease.expiresAt = event.expiresAt;
    task.updatedAt = envelope.at;
    if (event.progress?.trim()) state.progressSummary = event.progress.trim();
  },
  "task.evidence_added": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["running", "submitted", "reviewing"], event.type);
    const evidence = event.evidence;
    if (evidence.teamRunId !== state.id || evidence.taskId !== task.id || evidence.memberId !== task.assignedMemberId || state.evidence[evidence.id]) {
      throw new TeamError("TEAM_INVALID_CONTEXT", "Evidence identity does not match the task execution context.");
    }
    if (evidence.source === "runtime" && envelope.actor.kind !== "system") {
      throw new TeamError("TEAM_INVALID_CONTEXT", "Only the runtime may record runtime evidence.");
    }
    state.evidence[evidence.id] = structuredClone(evidence);
  },
  "task.artifact_added": (state, event) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["running", "submitted", "reviewing"], event.type);
    const artifact = event.artifact;
    if (artifact.roomId !== state.roomId || artifact.teamRunId !== state.id || artifact.taskId !== task.id
      || artifact.memberId !== task.assignedMemberId || state.artifacts[artifact.id]) {
      throw new TeamError("TEAM_INVALID_CONTEXT", "Artifact identity does not match the task execution context.");
    }
    if (Object.keys(state.artifacts).length >= TEAM_DEFAULTS.maxArtifacts) throw new TeamError("TEAM_CAPACITY_EXCEEDED", "TeamRun artifact limit reached.");
    state.artifacts[artifact.id] = structuredClone(artifact);
  },
  "task.submitted": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["running"], event.type);
    if (!event.submission) throw new TeamError("TEAM_INVALID_INPUT", "Task submission is required.");
    task.submission = structuredClone(event.submission);
    assertTaskCompletionGate({ ...state, reviewDecisions: {} }, { ...task, reviewPolicy: { ...task.reviewPolicy, required: false } });
    task.status = "submitted";
    task.lease = undefined;
    task.updatedAt = envelope.at;
    const dispatch = Object.values(state.activeDispatches).find((item) => item.taskId === task.id && item.attempt === task.attempt && item.purpose === "task");
    if (dispatch) updateDispatch(dispatch, envelope.at, { status: "completed" });
  },
  "task.review_requested": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["submitted", "reviewing"], event.type);
    if (!task.reviewPolicy.required || event.dispatches.length === 0) fail(`Task ${task.id} does not require review dispatches.`);
    for (const dispatch of event.dispatches) {
      if (dispatch.taskId !== task.id || dispatch.purpose !== "review" || dispatch.memberId === task.assignedMemberId) {
        throw new TeamError("TEAM_INVALID_CONTEXT", "Review dispatch must target an independent reviewer.");
      }
      state.activeDispatches[dispatch.dispatchId] = structuredClone(dispatch);
    }
    task.status = "reviewing";
    task.updatedAt = envelope.at;
    state.phase = "reviewing";
  },
  "task.review_submitted": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["reviewing"], event.type);
    const decision = event.decision;
    if (decision.teamRunId !== state.id || decision.taskId !== task.id || decision.round !== task.reviewRound
      || decision.reviewerMemberId === task.assignedMemberId || !task.reviewPolicy.reviewerMemberIds.includes(decision.reviewerMemberId)
      || state.reviewDecisions[decision.id]) {
      throw new TeamError("TEAM_INVALID_CONTEXT", "Review decision does not match the active review context.");
    }
    state.reviewDecisions[decision.id] = structuredClone(decision);
    for (const dispatch of Object.values(state.activeDispatches)) {
      if (dispatch.purpose === "review" && dispatch.taskId === task.id && dispatch.memberId === decision.reviewerMemberId && activeDispatchStatus(dispatch.status)) {
        updateDispatch(dispatch, envelope.at, { status: "completed" });
      }
    }
  },
  "task.changes_requested": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["reviewing"], event.type);
    const decisions = Object.values(state.reviewDecisions).filter((decision) => decision.taskId === task.id && decision.round === task.reviewRound);
    if (!decisions.some((decision) => decision.verdict === "changes_requested")) {
      throw new TeamError("TEAM_REVIEW_REQUIRED", "Changes requested requires a matching reviewer decision.");
    }
    task.status = "changes_requested";
    task.reviewRound += 1;
    task.updatedAt = envelope.at;
    state.phase = "running";
    state.progressSummary = requireText(event.reason, "Changes requested reason", 8_000);
  },
  "task.completed": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, task.reviewPolicy.required ? ["reviewing"] : ["submitted"], event.type);
    assertTaskCompletionGate(state, task);
    task.status = "completed";
    task.updatedAt = envelope.at;
    state.phase = "running";
  },
  "task.blocked": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["running"], event.type);
    task.status = "blocked";
    task.lease = undefined;
    task.updatedAt = envelope.at;
    state.progressSummary = requireText(event.reason, "Blocked reason", 8_000);
  },
  "task.failed": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["dispatching", "queued", "running"], event.type);
    task.status = "failed";
    task.lease = undefined;
    task.updatedAt = envelope.at;
    state.progressSummary = requireText(event.reason, "Task failure reason", 8_000);
  },
  "task.interrupted": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["dispatching", "queued", "running"], event.type);
    task.status = "interrupted";
    task.lease = undefined;
    task.updatedAt = envelope.at;
    state.progressSummary = requireText(event.reason, "Task interruption reason", 8_000);
  },
  "task.requeued": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    requireTaskStatus(task, ["changes_requested", "failed", "blocked", "interrupted"], event.type);
    if (task.attempt >= task.maxAttempts) fail(`Task ${task.id} exhausted its attempts.`);
    task.status = "ready";
    task.submission = undefined;
    task.lease = undefined;
    task.assignedMemberId = undefined;
    task.assignedSessionId = undefined;
    task.updatedAt = envelope.at;
    state.phase = "running";
    state.progressSummary = requireText(event.reason, "Requeue reason", 8_000);
  },
  "task.cancelled": (state, event, envelope) => {
    const task = requireTask(state, event.taskId);
    if (TERMINAL_TASK_STATUSES.has(task.status)) fail(`Task ${task.id} is already terminal.`);
    task.status = "cancelled";
    task.lease = undefined;
    task.updatedAt = envelope.at;
    state.progressSummary = requireText(event.reason, "Task cancellation reason", 8_000);
  },
  "dispatch.failed": (state, event, envelope) => {
    const task = state.tasks[event.taskId];
    const dispatch = requireDispatch(state, event.dispatchId, event.taskId);
    if (["completed", "failed", "interrupted"].includes(dispatch.status)) fail(`Dispatch ${dispatch.dispatchId} is already terminal.`);
    updateDispatch(dispatch, envelope.at, { status: "failed", errorCode: event.code, errorMessage: requireText(event.reason, "Dispatch failure reason", 8_000) });
    if (task && ["dispatching", "queued", "running"].includes(task.status)) {
      task.status = task.attempt < task.maxAttempts ? "ready" : "failed";
      task.lease = undefined;
      task.updatedAt = envelope.at;
    }
  },
};

export function reduceTeamRunEvent(current: TeamRunState | undefined, envelope: TeamRunEventEnvelope): TeamRunState {
  if (envelope.schemaVersion !== 1) throw new TeamError("TEAM_EVENT_LOG_CORRUPT", "Unsupported Team event schema version.");
  if (envelope.cursor < 1 || !Number.isInteger(envelope.cursor)) throw new TeamError("TEAM_EVENT_LOG_CORRUPT", "Team event cursor must be a positive integer.");
  const event = envelope.event;
  if (event.type === "run.created") {
    if (current) fail("TeamRun already exists.");
    if (envelope.cursor !== 1) throw new TeamError("TEAM_EVENT_LOG_CORRUPT", "The first TeamRun event must use cursor 1.");
    const objective = requireText(event.objective, "TeamRun objective", TEAM_DEFAULTS.maxInputBytes);
    return {
      schemaVersion: TEAM_RUN_SCHEMA_VERSION,
      id: envelope.teamRunId,
      roomId: envelope.roomId,
      revision: 1,
      objective,
      phase: "draft",
      createdBy: event.createdBy ?? (envelope.actor.kind === "member"
        ? { kind: "member", id: envelope.actor.memberId }
        : { kind: "user", id: envelope.actor.kind === "user" ? envelope.actor.id : "piora" }),
      coordinatorMemberId: event.coordinatorMemberId,
      tasks: {},
      successCriteria: [],
      activeDispatches: {},
      evidence: {},
      artifacts: {},
      reviewDecisions: {},
      finalArtifactIds: [],
      schedulingSteps: 0,
      retryGeneration: 0,
      createdAt: envelope.at,
      updatedAt: envelope.at,
    };
  }
  if (!current) throw new TeamError("TEAM_EVENT_LOG_CORRUPT", "TeamRun must begin with run.created.");
  if (current.roomId !== envelope.roomId || current.id !== envelope.teamRunId) {
    throw new TeamError("TEAM_EVENT_LOG_CORRUPT", "Team event identity does not match its projection.");
  }
  if (envelope.cursor !== current.revision + 1) {
    throw new TeamError("TEAM_EVENT_LOG_CORRUPT", "Team event cursor is not contiguous.", { expected: current.revision + 1, actual: envelope.cursor });
  }
  if (TERMINAL_RUN_PHASES.has(current.phase)) throw new TeamError("TEAM_ALREADY_TERMINAL", `TeamRun is already ${current.phase}.`);
  const state = copyState(current);
  state.revision = envelope.cursor;
  state.updatedAt = envelope.at;
  if ([
    "planning.requested", "plan.submitted", "run.started", "run.resumed", "run.synthesis_requested",
    "task.ready", "task.dispatch_requested", "task.review_requested", "task.changes_requested", "task.requeued",
  ].includes(event.type)) state.schedulingSteps += 1;
  if (state.schedulingSteps > TEAM_DEFAULTS.maxRunSteps) {
    throw new TeamError("TEAM_CAPACITY_EXCEEDED", "TeamRun exceeded its scheduling step fuse.");
  }

  const handler = TEAM_EVENT_HANDLERS[event.type as MutableTeamRunEvent["type"]];
  handler(state, event as never, envelope);
  return state;
}

export function replayTeamRunEvents(events: readonly TeamRunEventEnvelope[]): TeamRunState {
  if (events.length === 0) throw new TeamError("TEAM_RUN_NOT_FOUND", "TeamRun has no events.");
  let state: TeamRunState | undefined;
  const eventIds = new Set<string>();
  for (const envelope of events) {
    if (eventIds.has(envelope.id)) throw new TeamError("TEAM_EVENT_LOG_CORRUPT", "Team event id is duplicated.");
    eventIds.add(envelope.id);
    state = reduceTeamRunEvent(state, envelope);
  }
  return state!;
}

function mapRunPhase(phase: TeamRunPhase): TaskRunPhase {
  switch (phase) {
    case "draft": return "draft";
    case "planning": return "planned";
    case "waiting_user": return "waiting_user";
    case "reviewing":
    case "integrating":
    case "synthesizing": return "verifying";
    case "completed": return "completed";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    case "cancelled": return "cancelled";
    default: return "running";
  }
}

function projectionArtifacts(artifacts: readonly TeamArtifactReference[]): TaskRunState["artifacts"] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    summary: artifact.summary,
    createdAt: artifact.createdAt,
    source: "runtime",
  }));
}

export function deriveRunProjection(state: TeamRunState): TaskRunState {
  return {
    schemaVersion: 1,
    taskId: state.id,
    source: "room",
    objective: state.objective,
    phase: mapRunPhase(state.phase),
    attempt: 1,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
    ...(state.progressSummary ? { progress: state.progressSummary } : {}),
    ...(state.waitingReason ? { reason: state.waitingReason } : {}),
    evidence: Object.values(state.evidence).map((evidence) => ({
      id: evidence.id,
      kind: evidence.kind === "integration" || evidence.kind === "review" ? "observation" : evidence.kind,
      summary: evidence.summary,
      createdAt: evidence.createdAt,
      source: evidence.source,
      ...(evidence.toolName ? { toolName: evidence.toolName } : {}),
      ...(evidence.toolCallId ? { toolCallId: evidence.toolCallId } : {}),
    })),
    artifacts: projectionArtifacts(Object.values(state.artifacts)),
  };
}

export function deriveTaskProjection(state: TeamRunState, taskId: string): TaskRunState {
  const task = requireTask(state, taskId);
  const phaseByStatus: Record<TeamTaskStatus, TaskRunPhase> = {
    pending: "planned", ready: "planned", dispatching: "running", queued: "running", running: "running",
    submitted: "verifying", reviewing: "verifying", changes_requested: "blocked", completed: "completed",
    failed: "failed", blocked: "blocked", interrupted: "interrupted", cancelled: "cancelled", skipped: "completed",
  };
  const evidence = Object.values(state.evidence).filter((item) => item.taskId === task.id);
  const artifacts = Object.values(state.artifacts).filter((item) => item.taskId === task.id);
  return {
    schemaVersion: 1,
    taskId: task.id,
    source: "room",
    parentTaskId: state.id,
    ...(task.assignedSessionId ? { sessionId: task.assignedSessionId } : {}),
    objective: task.title,
    phase: phaseByStatus[task.status],
    attempt: task.attempt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.status === "completed" ? { finishedAt: task.updatedAt } : {}),
    evidence: evidence.map((item) => ({ id: item.id, kind: item.kind === "verification" ? "verification" : "observation", summary: item.summary, createdAt: item.createdAt, source: item.source })),
    artifacts: projectionArtifacts(artifacts),
  };
}

export function isTerminalTeamRun(state: TeamRunState): boolean {
  return TERMINAL_RUN_PHASES.has(state.phase);
}

export function taskReviewDecisions(state: TeamRunState, taskId: string): TeamReviewDecision[] {
  return Object.values(state.reviewDecisions).filter((decision) => decision.taskId === taskId);
}
