import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { appendRoomMessage, findRoomMessageByCorrelationId, getRoom } from "./room-store";
import { getSessionMessageRouter, type SessionMessageRouter } from "./session-message-router";
import type { SessionCommandEvent } from "./session-message-types";
import {
  deleteTeamExecutionSecret,
  persistTeamExecutionContext,
  resolveTeamExecutionContext,
} from "./team-execution-secrets";
import { TeamError } from "./team-errors";
import { deriveReadyTaskIds, isTerminalTeamRun } from "./team-run-reducer";
import { getTeamRunStore, type CreateTeamRunInput, type TeamRunStore } from "./team-run-store";
import {
  TEAM_DEFAULTS,
  type CollaborationRoomV3,
  type PersistedTeamExecutionRef,
  type RoomMemberV3,
  type TeamDispatchState,
  type TeamExecutionContext,
  type TeamRunState,
  type TeamTask,
} from "./team-types";

export type ReconcileReason =
  | "created" | "plan_submitted" | "task_changed" | "review_changed"
  | "command_event" | "lease_timeout" | "user_resumed" | "startup" | "manual";

interface CoordinatorOptions {
  store?: TeamRunStore;
  router?: Pick<SessionMessageRouter, "dispatchSessionMessage" | "cancelCommand" | "subscribeEvents">;
  now?: () => number;
  uuid?: () => string;
}

declare global {
  var __pioraTeamCoordinator: TeamCoordinatorService | undefined;
  var __pioraTeamReconcileLocks: Map<string, Promise<void>> | undefined;
}

function reconcileLocks(): Map<string, Promise<void>> {
  return globalThis.__pioraTeamReconcileLocks ??= new Map();
}

function runKey(roomId: string, runId: string): string {
  return `${roomId}:${runId}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function activeDispatch(dispatch: TeamDispatchState): boolean {
  return ["requested", "accepted", "queued", "running"].includes(dispatch.status);
}

function nextDispatchAttempt(state: TeamRunState, purpose: TeamExecutionContext["purpose"], taskId: string, memberId?: string): number {
  return Math.max(0, ...Object.values(state.activeDispatches)
    .filter((dispatch) => dispatch.purpose === purpose && dispatch.taskId === taskId
      && (dispatch.retryGeneration ?? 0) === (state.retryGeneration ?? 0)
      && (!memberId || dispatch.memberId === memberId))
    .map((dispatch) => dispatch.attempt)) + 1;
}

function memberLoad(state: TeamRunState, memberId: string): number {
  return Object.values(state.activeDispatches).filter((dispatch) => dispatch.memberId === memberId && activeDispatch(dispatch)).length;
}

function capabilityScore(task: TeamTask, member: RoomMemberV3, state: TeamRunState): number {
  if (member.binding.status !== "ready" || memberLoad(state, member.memberId) > 0) return Number.NEGATIVE_INFINITY;
  const available = new Set(member.profile.capabilities);
  const matched = task.requiredCapabilities.filter((capability) => available.has(capability)).length;
  if (task.assignmentMode === "fixed" && task.preferredMemberId !== member.memberId) return Number.NEGATIVE_INFINITY;
  const coverage = task.requiredCapabilities.length === 0 ? 1 : matched / task.requiredCapabilities.length;
  const preferred = task.preferredMemberId === member.memberId ? 50 : 0;
  const roleFit = member.profile.role === "worker" ? 20 : member.profile.role === "coordinator" ? 5 : 0;
  const workspace = member.profile.workspacePolicy.mode === "dedicated_worktree" ? 20 : 5;
  return coverage * 100 + preferred + roleFit + workspace - memberLoad(state, member.memberId) * 40;
}

function normalizedWorkspace(member: RoomMemberV3): string | undefined {
  const cwd = member.binding.cwd ?? member.binding.projectRoot;
  if (!cwd) return undefined;
  const normalized = resolve(cwd);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function hasWorkspaceConflict(room: CollaborationRoomV3, state: TeamRunState, candidate: RoomMemberV3): boolean {
  if (candidate.profile.workspacePolicy.mode === "read_only") return false;
  const target = normalizedWorkspace(candidate);
  if (!target) return false;
  for (const dispatch of Object.values(state.activeDispatches)) {
    if (!activeDispatch(dispatch) || dispatch.purpose !== "task" || dispatch.memberId === candidate.memberId) continue;
    const holder = room.members.find((member) => member.memberId === dispatch.memberId);
    if (holder && holder.profile.workspacePolicy.mode !== "read_only" && normalizedWorkspace(holder) === target) return true;
  }
  return false;
}

function chooseTaskMember(room: CollaborationRoomV3, state: TeamRunState, task: TeamTask): RoomMemberV3 | undefined {
  const candidates = room.members
    .map((member) => ({ member, score: hasWorkspaceConflict(room, state, member) ? Number.NEGATIVE_INFINITY : capabilityScore(task, member, state) }))
    .filter((candidate) => Number.isFinite(candidate.score));
  const exactMatches = task.requiredCapabilities.length === 0 ? candidates : candidates.filter(({ member }) => {
    const available = new Set(member.profile.capabilities);
    return task.requiredCapabilities.every((capability) => available.has(capability));
  });
  // Capability tags rank automatic assignments, but they must not make a
  // newly-created team unusable. Prefer an exact specialist whenever one is
  // available, then fall back to a ready generalist without asking the user
  // to edit low-level profile metadata.
  return (exactMatches.length > 0 ? exactMatches : candidates)
    .sort((left, right) => right.score - left.score
      || memberLoad(state, left.member.memberId) - memberLoad(state, right.member.memberId)
      || left.member.joinedAt - right.member.joinedAt
      || left.member.memberId.localeCompare(right.member.memberId))[0]?.member;
}

function dispatchPrompt(purpose: TeamExecutionContext["purpose"], task?: TeamTask): string {
  if (purpose === "planning") return "立即创建并提交结构化团队计划。使用 piora_room 的 submit_plan；计划提交后会自动执行，不需要用户批准，不要回复‘等待批准’。";
  if (purpose === "review") return `Review task ${task?.id ?? ""} independently and submit the decision through piora_room submit_review.`;
  if (purpose === "synthesis") return "Synthesize the verified TeamRun delivery and call piora_room complete_run. Prose alone cannot complete the run.";
  if (purpose === "replan") return "Repair the structured Team plan and submit it through piora_room replan.";
  return `Execute the active task ${task?.id ?? ""}, record evidence and artifacts, then submit through piora_room submit_task.`;
}

export class TeamCoordinatorService {
  readonly store: TeamRunStore;
  private readonly router: CoordinatorOptions["router"];
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly subscriptions = new Map<string, () => void>();

  constructor(options: CoordinatorOptions = {}) {
    this.store = options.store ?? getTeamRunStore();
    this.router = options.router ?? getSessionMessageRouter();
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
  }

  private publishRoomStatus(
    state: TeamRunState,
    correlationSuffix: string,
    content: string,
    member?: RoomMemberV3,
  ): void {
    const correlationId = `team:${state.id}:${correlationSuffix}`;
    if (findRoomMessageByCorrelationId(state.roomId, correlationId)) return;
    appendRoomMessage(state.roomId, {
      authorKind: member ? "session" : "system",
      authorId: member?.binding.sessionId ?? "piora",
      authorName: member?.profile.name ?? "Piora",
      content,
      correlationId,
    });
  }

  private publishVisibleMilestones(state: TeamRunState, room: CollaborationRoomV3): void {
    const coordinator = room.members.find((member) => member.memberId === state.coordinatorMemberId);
    const coordinatorName = coordinator?.profile.name ?? "协调者";
    if (state.plan) {
      const taskLines = state.plan.taskIds.map((taskId, index) => `${index + 1}. ${state.tasks[taskId]?.title ?? taskId}`);
      this.publishRoomStatus(
        state,
        `plan:${state.plan.revision}`,
        [`团队计划已开始，共 ${taskLines.length} 项任务：`, "", ...taskLines].join("\n"),
        coordinator,
      );
    }
    for (const task of Object.values(state.tasks)) {
      const member = room.members.find((candidate) => candidate.memberId === task.assignedMemberId);
      const started = ["dispatching", "queued", "running", "submitted", "reviewing", "completed", "blocked", "failed", "changes_requested"].includes(task.status);
      if (started && member) {
        this.publishRoomStatus(
          state,
          `task:${task.id}:attempt:${task.attempt}:started`,
          `@${member.profile.name} 请开始执行：**${task.title}**\n\n${task.description}`,
          coordinator,
        );
      }
      if (task.submission && member) {
        this.publishRoomStatus(
          state,
          `task:${task.id}:submitted:${task.submission.submittedAt}`,
          `@${coordinatorName} 我已完成并提交：**${task.title}**\n\n${task.submission.summary}`,
          member,
        );
      }
      if (task.status === "completed") {
        this.publishRoomStatus(
          state,
          `task:${task.id}:completed`,
          `已确认完成：**${task.title}**${task.submission?.summary ? `\n\n${task.submission.summary}` : ""}`,
          coordinator,
        );
      }
    }
    for (const dispatch of Object.values(state.activeDispatches)) {
      if (dispatch.purpose !== "review") continue;
      const task = state.tasks[dispatch.taskId];
      const reviewer = room.members.find((member) => member.memberId === dispatch.memberId);
      const worker = task ? room.members.find((member) => member.memberId === task.assignedMemberId) : undefined;
      if (!task || !reviewer) continue;
      this.publishRoomStatus(
        state,
        `review:${dispatch.dispatchId}:requested`,
        `@${reviewer.profile.name} 请现在审查 ${worker?.profile.name ?? "执行者"} 已提交的：**${task.title}**\n\n编码任务已提交，审查从此刻开始。`,
        coordinator,
      );
    }
    for (const decision of Object.values(state.reviewDecisions)) {
      const task = state.tasks[decision.taskId];
      const reviewer = room.members.find((member) => member.memberId === decision.reviewerMemberId);
      if (!task || !reviewer) continue;
      this.publishRoomStatus(
        state,
        `review:${decision.id}:submitted`,
        `@${coordinatorName} 审查已完成：**${task.title}**\n\n结论：${decision.verdict === "approved" ? "通过" : "需要修改"}\n\n${decision.summary}`,
        reviewer,
      );
    }
  }

  async createRun(input: CreateTeamRunInput): Promise<TeamRunState> {
    return this.serialize(input.roomId, "__create__", async () => {
      const room = getRoom(input.roomId);
      if (room.coordination.mode !== "team") throw new TeamError("TEAM_INVALID_INPUT", "当前协作空间尚未启用团队编排模式。");
      await this.store.migrateLegacyRoomTasks(room.id, room.coordination.coordinatorMemberId);
      if (input.correlationId) {
        const existing = this.store.findTeamRunByCorrelationId(room.id, input.correlationId);
        if (existing) return existing;
      }
      const active = this.store.listTeamRuns(room.id, { includeTerminal: false, limit: 10 });
      if (TEAM_DEFAULTS.oneActiveRunPerRoom && active.length > 0) {
        throw new TeamError("TEAM_REVISION_CONFLICT", "当前协作空间已有运行中的团队任务。", { teamRunId: active[0]!.id });
      }
      const state = await this.store.createTeamRun({ ...input, coordinatorMemberId: room.coordination.coordinatorMemberId });
      return this.reconcile(state.roomId, state.id, "created");
    });
  }

  private async serialize<T>(roomId: string, teamRunId: string, operation: () => Promise<T>): Promise<T> {
    const key = runKey(roomId, teamRunId);
    const previous = reconcileLocks().get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    reconcileLocks().set(key, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (reconcileLocks().get(key) === chain) reconcileLocks().delete(key);
    }
  }

  private createDispatch(
    state: TeamRunState,
    member: RoomMemberV3,
    taskId: string,
    purpose: TeamExecutionContext["purpose"],
    attempt: number,
  ): { dispatch: TeamDispatchState; context: TeamExecutionContext } {
    const now = this.now();
    const leaseToken = this.uuid();
    const dispatchId = this.uuid();
    const dispatch: TeamDispatchState = {
      dispatchId,
      purpose,
      taskId,
      memberId: member.memberId,
      sessionId: member.binding.sessionId,
      attempt,
      retryGeneration: state.retryGeneration ?? 0,
      leaseTokenHash: hashToken(leaseToken),
      status: "requested",
      requestedAt: now,
      updatedAt: now,
    };
    const context: TeamExecutionContext = {
      schemaVersion: 1,
      roomId: state.roomId,
      teamRunId: state.id,
      taskId,
      dispatchId,
      memberId: member.memberId,
      profileRevision: member.profile.revision,
      attempt,
      leaseToken,
      purpose,
    };
    return { dispatch, context };
  }

  private async queueDispatch(state: TeamRunState, context: TeamExecutionContext, prompt: string): Promise<void> {
    const ref = persistTeamExecutionContext(context);
    const retryGeneration = state.activeDispatches[context.dispatchId]?.retryGeneration ?? 0;
    await this.store.appendTeamOutbox(state.roomId, state.id, {
      kind: "dispatch",
      idempotencyKey: `team:${state.roomId}:${state.id}:${context.taskId}:${context.purpose}:${retryGeneration}:${context.attempt}`,
      payload: { targetSessionId: context.memberId, sessionId: this.dispatchSession(state, context.dispatchId), prompt, teamExecutionRef: ref },
    });
  }

  private dispatchSession(state: TeamRunState, dispatchId: string): string {
    const dispatch = state.activeDispatches[dispatchId];
    if (!dispatch) throw new TeamError("TEAM_INVALID_CONTEXT", "Dispatch was not persisted before its outbox item.");
    return dispatch.sessionId;
  }

  private async requestPlanning(state: TeamRunState, room: CollaborationRoomV3): Promise<TeamRunState> {
    const memberId = room.coordination.plannerMemberId ?? room.coordination.coordinatorMemberId;
    const member = room.members.find((candidate) => candidate.memberId === memberId);
    if (!member) throw new TeamError("TEAM_MEMBER_NOT_FOUND", "协作空间中没有可负责规划的智能体。");
    const attempt = nextDispatchAttempt(state, "planning", "__planning__", member.memberId);
    if (attempt > TEAM_DEFAULTS.maxTaskAttempts) {
      return this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{
        type: "run.interrupted", reason: "系统连续多次未能生成有效计划。这不是你缺少信息；可点击“重试运行”让系统重新规划。",
      }]);
    }
    const { dispatch, context } = this.createDispatch(state, member, "__planning__", "planning", attempt);
    const next = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{ type: "planning.requested", dispatch }]);
    await this.queueDispatch(next, context, dispatchPrompt("planning"));
    await this.deliverPendingOutbox(next.roomId, next.id);
    const current = this.store.getTeamRun(next.roomId, next.id);
    return activeDispatch(current.activeDispatches[dispatch.dispatchId]!) ? current : this.requestPlanning(current, room);
  }

  private async dispatchTask(state: TeamRunState, room: CollaborationRoomV3, task: TeamTask): Promise<TeamRunState> {
    const member = chooseTaskMember(room, state, task);
    if (!member) return state;
    const { dispatch, context } = this.createDispatch(state, member, task.id, "task", task.attempt + 1);
    const next = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{
      type: "task.dispatch_requested", taskId: task.id, dispatch, leaseTokenHash: dispatch.leaseTokenHash,
    }]);
    await this.queueDispatch(next, context, dispatchPrompt("task", task));
    return next;
  }

  private async requestReview(state: TeamRunState, room: CollaborationRoomV3, task: TeamTask): Promise<TeamRunState> {
    const configured = task.reviewPolicy.reviewerMemberIds.length > 0
      ? task.reviewPolicy.reviewerMemberIds
      : room.coordination.defaultReviewerMemberIds;
    const decisions = Object.values(state.reviewDecisions)
      .filter((decision) => decision.taskId === task.id && decision.round === task.reviewRound);
    const decidedMembers = new Set(decisions.map((decision) => decision.reviewerMemberId));
    const activeMembers = new Set(Object.values(state.activeDispatches)
      .filter((dispatch) => dispatch.purpose === "review" && dispatch.taskId === task.id && activeDispatch(dispatch))
      .map((dispatch) => dispatch.memberId));
    const approvalsNeeded = Math.max(0, task.reviewPolicy.minimumApprovals
      - new Set(decisions.filter((decision) => decision.verdict === "approved").map((decision) => decision.reviewerMemberId)).size);
    const eligibleReviewers = (memberIds: string[]) => memberIds
      .map((id) => room.members.find((member) => member.memberId === id))
      .filter((member): member is RoomMemberV3 => Boolean(member
        && member.binding.status === "ready"
        && !decidedMembers.has(member.memberId)
        && !activeMembers.has(member.memberId)))
      .filter((member) => nextDispatchAttempt(state, "review", task.id, member.memberId) <= TEAM_DEFAULTS.maxTaskAttempts);
    const configuredReviewers = eligibleReviewers(configured);
    // Review is an automatic quality gate, not a request for human approval.
    // A small team must remain usable, so fall back to any ready member when
    // the preferred independent reviewers are unavailable.
    const fallbackReviewers = eligibleReviewers(room.members.map((member) => member.memberId))
      .filter((member) => !configuredReviewers.some((configuredMember) => configuredMember.memberId === member.memberId));
    const reviewers = [...configuredReviewers, ...fallbackReviewers].slice(0, Math.max(1, approvalsNeeded));
    if (approvalsNeeded === 0) return state;
    if (reviewers.length < approvalsNeeded) {
      return this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{
        type: "run.interrupted",
        reason: `任务“${task.title}”暂时没有可运行的智能体完成自动质量检查。请确认成员在线后重试；无需人工审批。`,
      }]);
    }
    const work = reviewers.map((reviewer) => this.createDispatch(
      state, reviewer, task.id, "review", nextDispatchAttempt(state, "review", task.id, reviewer.memberId),
    ));
    let next = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{
      type: "task.review_requested", taskId: task.id, dispatches: work.map((item) => item.dispatch),
    }]);
    for (const item of work) await this.queueDispatch(next, item.context, dispatchPrompt("review", task));
    next = this.store.getTeamRun(state.roomId, state.id);
    return next;
  }

  private async requestSynthesis(state: TeamRunState, room: CollaborationRoomV3): Promise<TeamRunState> {
    const member = room.members.find((candidate) => candidate.memberId === state.coordinatorMemberId);
    if (!member) throw new TeamError("TEAM_MEMBER_NOT_FOUND", "未找到协调智能体。");
    const attempt = nextDispatchAttempt(state, "synthesis", "__synthesis__", member.memberId);
    if (attempt > TEAM_DEFAULTS.maxTaskAttempts) {
      return this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{
        type: "run.interrupted", reason: "系统连续多次未能生成最终汇总。这不是你缺少信息；可点击“重试运行”再次汇总。",
      }]);
    }
    const { dispatch, context } = this.createDispatch(state, member, "__synthesis__", "synthesis", attempt);
    const next = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{ type: "run.synthesis_requested", dispatch }]);
    await this.queueDispatch(next, context, dispatchPrompt("synthesis"));
    await this.deliverPendingOutbox(next.roomId, next.id);
    const current = this.store.getTeamRun(next.roomId, next.id);
    return activeDispatch(current.activeDispatches[dispatch.dispatchId]!) ? current : this.requestSynthesis(current, room);
  }

  async deliverPendingOutbox(roomId: string, teamRunId: string): Promise<void> {
    for (const record of this.store.listTeamOutbox(roomId, teamRunId, { pendingOnly: true })) {
      if (record.kind === "room_message") {
        const state = this.store.getTeamRun(roomId, teamRunId);
        if (state.phase !== "completed") continue;
        const summary = record.payload.summary;
        const authorMemberId = record.payload.authorMemberId;
        if (typeof summary !== "string" || typeof authorMemberId !== "string") {
          await this.store.markTeamOutboxFailed(roomId, teamRunId, record.id, "TEAM_INVALID_CONTEXT");
          continue;
        }
        if (!findRoomMessageByCorrelationId(roomId, record.idempotencyKey)) {
          const room = getRoom(roomId);
          const author = room.members.find((member) => member.memberId === authorMemberId)
            ?? room.members.find((member) => member.memberId === state.coordinatorMemberId);
          if (!author) throw new TeamError("TEAM_MEMBER_NOT_FOUND", "未找到协调智能体。");
          appendRoomMessage(roomId, {
            authorKind: "session",
            authorId: author.binding.sessionId,
            authorName: author.profile.name,
            content: summary,
            correlationId: record.idempotencyKey,
          });
        }
        await this.store.markTeamOutboxDelivered(roomId, teamRunId, record.id);
        continue;
      }
      if (record.kind !== "dispatch") continue;
      const ref = record.payload.teamExecutionRef as PersistedTeamExecutionRef | undefined;
      const sessionId = record.payload.sessionId;
      const prompt = record.payload.prompt;
      if (!ref || typeof sessionId !== "string" || typeof prompt !== "string") {
        await this.store.markTeamOutboxFailed(roomId, teamRunId, record.id, "TEAM_INVALID_CONTEXT");
        continue;
      }
      try {
        const context = resolveTeamExecutionContext(ref);
        const receipt = await this.router!.dispatchSessionMessage({
          targetSessionId: sessionId,
          content: prompt,
          source: "room",
          roomContext: { roomId, messageId: context.dispatchId },
          idempotencyKey: record.idempotencyKey,
          teamExecution: context,
          expiresAt: this.now() + TEAM_DEFAULTS.dispatchQueueTimeoutMs,
        });
        let state = this.store.getTeamRun(roomId, teamRunId);
        const dispatch = state.activeDispatches[context.dispatchId];
        if (dispatch && !dispatch.commandId) {
          state = await this.store.appendTeamRunEvents(roomId, teamRunId, state.revision, [{
            type: "task.dispatch_accepted", taskId: context.taskId, dispatchId: context.dispatchId, commandId: receipt.commandId,
          }]);
        }
        await this.store.markTeamOutboxDelivered(roomId, teamRunId, record.id);
        deleteTeamExecutionSecret(ref);
        this.ensureSessionSubscription(sessionId);
      } catch (error) {
        await this.store.markTeamOutboxFailed(roomId, teamRunId, record.id, (error as { code?: string }).code ?? "DISPATCH_FAILED");
        const state = this.store.getTeamRun(roomId, teamRunId);
        const dispatchId = ref.dispatchId;
        if (state.activeDispatches[dispatchId] && activeDispatch(state.activeDispatches[dispatchId]!)) {
          await this.store.appendTeamRunEvents(roomId, teamRunId, state.revision, [{
            type: "dispatch.failed", dispatchId, taskId: ref.taskId, code: (error as { code?: string }).code, reason: error instanceof Error ? error.message : "任务分派失败。",
          }]);
        }
      }
    }
  }

  private ensureSessionSubscription(sessionId: string): void {
    if (this.subscriptions.has(sessionId)) return;
    const unsubscribe = this.router!.subscribeEvents(sessionId, (event) => { void this.onSessionCommandEvent(event); });
    this.subscriptions.set(sessionId, unsubscribe);
  }

  private async recoverExpiredTasks(state: TeamRunState, now: number): Promise<TeamRunState> {
    for (const task of Object.values(state.tasks)) {
      if (task.status !== "running" || !task.lease?.expiresAt || task.lease.expiresAt > now) continue;
      state = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [
        { type: "task.interrupted", taskId: task.id, reason: "任务执行租约已过期。" },
        ...(task.attempt < task.maxAttempts ? [{ type: "task.requeued", taskId: task.id, reason: "Retry after lease expiry." } as const] : []),
      ]);
    }
    return state;
  }

  private async markReadyTasks(state: TeamRunState): Promise<TeamRunState> {
    for (const taskId of deriveReadyTaskIds(state)) {
      state = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{ type: "task.ready", taskId }]);
    }
    return state;
  }

  private async reconcilePromptPhase(state: TeamRunState, room: CollaborationRoomV3): Promise<TeamRunState | undefined> {
    if (state.phase === "draft") return this.requestPlanning(state, room);
    if (state.phase === "waiting_user") {
      await this.deliverPendingOutbox(state.roomId, state.id);
      return this.store.getTeamRun(state.roomId, state.id);
    }
    if (state.phase === "planning") {
      await this.deliverPendingOutbox(state.roomId, state.id);
      const refreshed = this.store.getTeamRun(state.roomId, state.id);
      const hasPlanningDispatch = Object.values(refreshed.activeDispatches)
        .some((dispatch) => dispatch.purpose === "planning" && activeDispatch(dispatch));
      return !refreshed.plan && !hasPlanningDispatch ? this.requestPlanning(refreshed, room) : refreshed;
    }
    if (state.phase === "synthesizing") {
      await this.deliverPendingOutbox(state.roomId, state.id);
      const refreshed = this.store.getTeamRun(state.roomId, state.id);
      const hasSynthesisDispatch = Object.values(refreshed.activeDispatches)
        .some((dispatch) => dispatch.purpose === "synthesis" && activeDispatch(dispatch));
      return hasSynthesisDispatch ? refreshed : this.requestSynthesis(refreshed, room);
    }
    return undefined;
  }

  private async advanceTaskReviews(state: TeamRunState, room: CollaborationRoomV3): Promise<TeamRunState> {
    for (const task of Object.values(state.tasks)) {
      if (task.status === "submitted") {
        state = task.reviewPolicy.required
          ? await this.requestReview(state, room, task)
          : await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{ type: "task.completed", taskId: task.id }]);
        continue;
      }
      if (task.status !== "reviewing") continue;
      const decisions = Object.values(state.reviewDecisions)
        .filter((decision) => decision.taskId === task.id && decision.round === task.reviewRound);
      const changes = decisions.find((decision) => decision.verdict === "changes_requested");
      if (changes) {
        state = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [
          { type: "task.changes_requested", taskId: task.id, reason: changes.summary },
          ...(task.attempt < task.maxAttempts ? [{ type: "task.requeued", taskId: task.id, reason: "Reviewer requested changes." } as const] : []),
        ]);
        if (task.reviewRound + 1 >= TEAM_DEFAULTS.maxReviewRounds || task.attempt >= task.maxAttempts) {
          return this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{ type: "run.failed", reason: `任务“${task.title}”已达到审查或执行重试上限。` }]);
        }
        continue;
      }
      const approvals = new Set(decisions.filter((decision) => decision.verdict === "approved").map((decision) => decision.reviewerMemberId)).size;
      if (approvals >= task.reviewPolicy.minimumApprovals) {
        state = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{ type: "task.completed", taskId: task.id }]);
        continue;
      }
      const reviewActive = Object.values(state.activeDispatches)
        .some((dispatch) => dispatch.purpose === "review" && dispatch.taskId === task.id && activeDispatch(dispatch));
      if (!reviewActive) state = await this.requestReview(state, room, task);
    }
    return state;
  }

  private async dispatchReadyTasks(state: TeamRunState, room: CollaborationRoomV3): Promise<TeamRunState> {
    const activeCount = Object.values(state.activeDispatches).filter(activeDispatch).length;
    let capacity = Math.max(0, room.coordination.maxConcurrency - activeCount);
    const readyTasks = Object.values(state.tasks)
      .filter((task) => task.status === "ready")
      .sort((left, right) => right.priority - left.priority);
    for (const task of readyTasks) {
      if (capacity <= 0) break;
      const next = await this.dispatchTask(state, room, task);
      if (next.revision === state.revision) continue;
      state = next;
      capacity -= 1;
    }
    return state;
  }

  private async resolveStalledOrFinishedRun(state: TeamRunState): Promise<TeamRunState | undefined> {
    const tasks = Object.values(state.tasks);
    const activeDispatches = Object.values(state.activeDispatches);
    if (tasks.length > 0
      && tasks.every((task) => ["completed", "skipped", "cancelled"].includes(task.status))
      && !activeDispatches.some((dispatch) => activeDispatch(dispatch) && dispatch.purpose !== "task")) {
      return this.requestSynthesis(state, getRoom(state.roomId));
    }
    const canProgress = tasks.some((task) => ["ready", "dispatching", "queued", "running", "submitted", "reviewing"].includes(task.status));
    if (tasks.some((task) => task.status === "blocked") && !canProgress) {
      const blockedTasks = tasks.filter((task) => task.status === "blocked");
      const detail = state.progressSummary?.trim() || "执行智能体没有提供更多说明";
      const question = `任务“${blockedTasks.map((task) => task.title).join("、")}”遇到阻塞：${detail}\n请直接在群聊中告诉我应如何处理，我会带着你的回答自动继续运行。`;
      const waiting = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{ type: "run.waiting_user", reason: question }]);
      const correlationId = `team:${state.id}:question:${waiting.retryGeneration ?? 0}`;
      if (!findRoomMessageByCorrelationId(state.roomId, correlationId)) {
        appendRoomMessage(state.roomId, {
          authorKind: "system",
          authorId: "piora",
          authorName: "Piora",
          content: `需要你的回答\n\n${question}`,
          correlationId,
        });
      }
      return waiting;
    }
    const terminalFailure = tasks.find((task) => task.status === "failed" || (task.status === "interrupted" && task.attempt >= task.maxAttempts));
    if (terminalFailure && !activeDispatches.some(activeDispatch)) {
      return this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{ type: "run.failed", reason: `任务“${terminalFailure.title}”失败且无法继续重试。` }]);
    }
    return undefined;
  }

  private async reconcileUnlocked(roomId: string, teamRunId: string, _reason: ReconcileReason): Promise<TeamRunState> {
    void _reason;
    let state = this.store.getTeamRun(roomId, teamRunId);
    const room = getRoom(roomId);
    this.publishVisibleMilestones(state, room);
    if (isTerminalTeamRun(state)) return state;

    state = await this.recoverExpiredTasks(state, this.now());
    state = await this.markReadyTasks(state);
    const promptPhaseResult = await this.reconcilePromptPhase(state, room);
    if (promptPhaseResult) return promptPhaseResult;

    this.publishVisibleMilestones(state, room);
    state = await this.advanceTaskReviews(state, room);
    if (isTerminalTeamRun(state)) return state;
    state = await this.markReadyTasks(state);

    const activeTaskStatuses = ["dispatching", "queued", "running", "submitted", "reviewing"];
    const stranded = Object.values(state.tasks).filter((task) => task.status === "ready" && !chooseTaskMember(room, state, task));
    const hasActiveTask = Object.values(state.tasks).some((task) => activeTaskStatuses.includes(task.status));
    if (stranded.length > 0 && !hasActiveTask) {
      return this.store.appendTeamRunEvents(roomId, teamRunId, state.revision, [{
        type: "run.interrupted",
        reason: `当前没有在线的智能体可执行“${stranded.map((task) => task.title).join("、")}”。系统已保留进度；成员恢复在线后可重试运行。`,
      }]);
    }

    state = await this.dispatchReadyTasks(state, room);
    this.publishVisibleMilestones(state, room);
    const revisionBeforeDelivery = state.revision;
    await this.deliverPendingOutbox(roomId, teamRunId);
    state = this.store.getTeamRun(roomId, teamRunId);
    if (state.revision !== revisionBeforeDelivery && !isTerminalTeamRun(state)) {
      return this.reconcileUnlocked(roomId, teamRunId, "manual");
    }

    return await this.resolveStalledOrFinishedRun(state) ?? state;
  }

  reconcile(roomId: string, teamRunId: string, reason: ReconcileReason): Promise<TeamRunState> {
    return this.serialize(roomId, teamRunId, () => this.reconcileUnlocked(roomId, teamRunId, reason));
  }

  async resumeRun(roomId: string, teamRunId: string, guidance?: string): Promise<TeamRunState> {
    const state = this.store.getTeamRun(roomId, teamRunId);
    const resumed = await this.store.appendTeamRunEvents(roomId, teamRunId, state.revision, [{ type: "run.resumed", guidance }]);
    return this.reconcile(resumed.roomId, resumed.id, "user_resumed");
  }

  async cancelRun(roomId: string, teamRunId: string, reason: string): Promise<TeamRunState> {
    let state = this.store.getTeamRun(roomId, teamRunId);
    if (isTerminalTeamRun(state)) return state;
    for (const dispatch of Object.values(state.activeDispatches)) {
      if (activeDispatch(dispatch) && dispatch.commandId) await this.router!.cancelCommand(dispatch.commandId).catch(() => undefined);
    }
    state = this.store.getTeamRun(roomId, teamRunId);
    return this.store.appendTeamRunEvents(roomId, teamRunId, state.revision, [{ type: "run.cancelled", reason }]);
  }

  async recoverAll(): Promise<void> {
    for (const roomId of this.store.listRoomIds()) {
      try {
        const room = getRoom(roomId);
        await this.store.migrateLegacyRoomTasks(roomId, room.coordination.coordinatorMemberId);
      } catch { /* Corrupt/partial Rooms remain isolated from process startup. */ }
    }
    for (const state of await this.store.recoverUnfinishedTeamRuns()) {
      for (const dispatch of Object.values(state.activeDispatches)) if (activeDispatch(dispatch)) this.ensureSessionSubscription(dispatch.sessionId);
      await this.reconcile(state.roomId, state.id, "startup");
    }
    for (const roomId of this.store.listRoomIds()) {
      for (const state of this.store.listTeamRuns(roomId, { limit: 500 })) {
        if (state.phase === "completed") await this.deliverPendingOutbox(roomId, state.id);
      }
    }
  }

  async onSessionCommandEvent(event: SessionCommandEvent): Promise<void> {
    if (!event.commandId) return;
    const roomsRoot = this.store.roomsRoot;
    const { readdirSync, existsSync } = await import("node:fs");
    if (!existsSync(roomsRoot)) return;
    for (const room of readdirSync(roomsRoot, { withFileTypes: true })) {
      if (!room.isDirectory()) continue;
      for (const state of this.store.listTeamRuns(room.name, { limit: 500, includeTerminal: false })) {
        const dispatch = Object.values(state.activeDispatches).find((candidate) => candidate.commandId === event.commandId);
        if (!dispatch) continue;
        let current = state;
        if (event.type === "prompt_started" && event.runId && dispatch.status !== "running") {
          current = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{
            type: "task.prompt_started", taskId: dispatch.taskId, dispatchId: dispatch.dispatchId, promptRunId: event.runId,
          }]);
        } else if (["command_failed", "command_interrupted", "command_cancelled", "command_expired", "prompt_error"].includes(event.type) && activeDispatch(dispatch)) {
          current = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{
            type: "dispatch.failed", dispatchId: dispatch.dispatchId, taskId: dispatch.taskId, code: event.errorCode, reason: event.errorMessage ?? event.errorCode ?? "会话命令执行失败。",
          }]);
        } else if (event.type === "command_completed" && activeDispatch(dispatch)) {
          const task = current.tasks[dispatch.taskId];
          if (dispatch.purpose === "task" && task?.status === "running") {
            current = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [
              { type: "task.interrupted", taskId: task.id, reason: "智能体回复结束，但没有提交结构化任务结果。" },
              ...(task.attempt < task.maxAttempts ? [{ type: "task.requeued", taskId: task.id, reason: "Retry after missing structured submission." } as const] : []),
            ]);
          } else {
            current = await this.store.appendTeamRunEvents(state.roomId, state.id, state.revision, [{
              type: "dispatch.failed", dispatchId: dispatch.dispatchId, taskId: dispatch.taskId,
              code: "TEAM_STRUCTURED_SUBMISSION_REQUIRED",
              reason: `智能体回复结束，但没有提交所需的结构化“${dispatch.purpose}”结果。`,
            }]);
          }
        }
        await this.reconcile(current.roomId, current.id, "command_event");
        return;
      }
    }
  }

  destroy(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }
}

export function getTeamCoordinatorService(): TeamCoordinatorService {
  const current = globalThis.__pioraTeamCoordinator;
  // globalThis preserves active subscriptions across Next.js hot reloads. An
  // instance from the previous module evaluation otherwise keeps invoking its
  // old prototype methods, so refresh the prototype without destroying active
  // commands or requiring a manually maintained version counter.
  if (current) {
    if (!(current instanceof TeamCoordinatorService)) Object.setPrototypeOf(current, TeamCoordinatorService.prototype);
    return current;
  }
  return globalThis.__pioraTeamCoordinator = new TeamCoordinatorService();
}

export function resetTeamCoordinatorForTests(): void {
  globalThis.__pioraTeamCoordinator?.destroy();
  globalThis.__pioraTeamCoordinator = undefined;
  globalThis.__pioraTeamReconcileLocks?.clear();
}
