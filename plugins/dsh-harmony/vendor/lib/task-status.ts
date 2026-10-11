import type { TaskRunState } from "./task-run";

export type Lifecycle = "draft" | "active" | "archived";
export type Runtime = "idle" | "running" | "compacting" | "stopping";
export type Attention = "none" | "needs_input" | "needs_approval" | "failed" | "unread";

export interface TaskStatus {
  lifecycle: Lifecycle;
  runtime: Runtime;
  attention: Attention;
  /** Server-owned start time for the current run. Survives task switches. */
  startedAt?: number;
  taskRun?: TaskRunState;
}

export interface TaskStatusInput {
  sessionId: string;
  runningIds: Set<string>;
  compactingIds: Set<string>;
  pendingApprovalIds: Set<string>;
  lastPromptFailed: boolean;
  hasUnreadResult: boolean;
  archived: boolean;
  isViewing: boolean;
  taskRun?: TaskRunState;
}

export type TaskStatusPresentationKey = Attention | "running";

export interface TaskRuntimeSnapshot {
  id: string;
  runtime: Runtime;
  pendingApproval: boolean;
  lastPromptFailed: boolean;
  errorSummary?: string;
  startedAt?: number;
  title?: string;
  activity?: TaskRuntimeActivity;
  /** Current model context usage for this task; totals only, never message content. */
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null };
  taskRun?: TaskRunState;
}

export type TaskRuntimeActivityKind =
  | "prompt"
  | "thinking"
  | "assistant"
  | "tool"
  | "command"
  | "compacting"
  | "approval"
  | "retry";

export interface TaskRuntimeActivity {
  kind: TaskRuntimeActivityKind;
  message: string;
  updatedAt: number;
}

export interface RunningSessionsPayload {
  /** Compatibility field for clients from before the three-axis status model. */
  runningSessionIds: string[];
  runningSessions: TaskRuntimeSnapshot[];
}

export const STATUS_PRESENTATION: Record<TaskStatusPresentationKey, {
  colorVar: string;
  i18nKey: string;
}> = {
  running: { colorVar: "--status-running", i18nKey: "taskStatus.running" },
  needs_approval: { colorVar: "--status-attention", i18nKey: "taskStatus.needsApproval" },
  needs_input: { colorVar: "--status-attention", i18nKey: "taskStatus.needsInput" },
  failed: { colorVar: "--status-failed", i18nKey: "taskStatus.failed" },
  unread: { colorVar: "--status-ready", i18nKey: "taskStatus.unread" },
  none: { colorVar: "transparent", i18nKey: "taskStatus.none" },
};

export function deriveTaskStatus(input: TaskStatusInput): TaskStatus {
  const lifecycle: Lifecycle = input.archived
    ? "archived"
    : input.sessionId
      ? "active"
      : "draft";

  const runtime: Runtime = input.compactingIds.has(input.sessionId)
    ? "compacting"
    : input.runningIds.has(input.sessionId)
      ? "running"
      : "idle";

  let attention: Attention = "none";
  if (!input.isViewing) {
    if (input.pendingApprovalIds.has(input.sessionId) || input.taskRun?.phase === "waiting_approval") attention = "needs_approval";
    else if (input.taskRun?.phase === "waiting_user") attention = "needs_input";
    else if (input.lastPromptFailed || input.taskRun?.phase === "failed") attention = "failed";
    else if (input.hasUnreadResult) attention = "unread";
  }

  return {
    lifecycle,
    runtime,
    attention,
    ...(input.taskRun ? { taskRun: input.taskRun } : {}),
  };
}

export function getTaskStatusPresentationKey(status: TaskStatus): TaskStatusPresentationKey {
  if (status.attention !== "none") return status.attention;
  return status.runtime === "idle" ? "none" : "running";
}

export function createRunningSessionsPayload(sessions: TaskRuntimeSnapshot[]): RunningSessionsPayload {
  return {
    runningSessionIds: sessions
      .filter((session) => session.runtime !== "idle")
      .map((session) => session.id),
    runningSessions: sessions,
  };
}
