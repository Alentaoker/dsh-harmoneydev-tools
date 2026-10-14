export type AutomationKind = "heartbeat" | "cron";
export type AutomationStatus = "ACTIVE" | "PAUSED";
export type AutomationNotificationPolicy = "always" | "important_updates" | "failed_runs_only" | "never";

export interface AutomationSessionTarget {
  type: "session";
  sessionId: string;
  cwd?: string;
  sessionName?: string;
}

export interface AutomationProjectTarget {
  type: "project";
  cwd: string;
}

export type AutomationTarget = AutomationSessionTarget | AutomationProjectTarget;

export interface AutomationDefinition {
  version: 1;
  id: string;
  kind: AutomationKind;
  name: string;
  prompt: string;
  status: AutomationStatus;
  rrule: string;
  timezone: string;
  target: AutomationTarget;
  notificationPolicy: AutomationNotificationPolicy;
  model?: string;
  reasoningEffort?: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt?: number;
}

export type AutomationRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "skipped";

export interface AutomationRun {
  id: string;
  automationId: string;
  scheduledFor: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  status: AutomationRunStatus;
  sessionId?: string;
  commandId?: string;
  error?: string;
}

export interface AutomationNotification {
  id: string;
  automationId: string;
  runId: string;
  sessionId?: string;
  title: string;
  status: "succeeded" | "failed" | "interrupted";
  createdAt: number;
  deliveredAt?: number;
}

export interface CreateAutomationInput {
  kind: AutomationKind;
  name: string;
  prompt: string;
  status?: AutomationStatus;
  rrule: string;
  timezone?: string;
  target: AutomationTarget;
  notificationPolicy?: AutomationNotificationPolicy;
  model?: string;
  reasoningEffort?: string;
}

export type UpdateAutomationInput = Partial<Omit<CreateAutomationInput, "kind" | "target">> & {
  kind?: AutomationKind;
  target?: AutomationTarget;
};

export interface AutomationSummary extends AutomationDefinition {
  latestRun?: AutomationRun;
  running: boolean;
}
