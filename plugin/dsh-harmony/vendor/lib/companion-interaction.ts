import type { SessionStatsInfo } from "./pi-types";
import type { CompanionInteractionModel, CompanionTodo } from "./companion-store";
import type { TaskRuntimeSnapshot } from "./task-status";

export const COMPANION_WORK_RHYTHM_STORAGE_KEY = "pi-companion-work-rhythm-v1";
export const COMPANION_REST_GAP_MS = 10 * 60 * 1_000;

export interface CompanionWorkRhythm {
  day: string;
  continuousSince: number | null;
  lastActiveAt: number | null;
  lastRestAt: number | null;
  completedToday: number;
  failedToday: number;
  taskStates: Record<string, "running" | "failed">;
}

export interface CompanionSessionContext {
  cwd?: string;
  sessionId?: string;
  sessionTitle?: string;
  status?: string;
  stats?: SessionStatsInfo | null;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
}

export interface CompanionInteractionContext {
  generatedAt: number;
  continuousWorkMinutes: number;
  minutesSinceLastRest: number | null;
  completedToday: number;
  failedToday: number;
  currentSession?: {
    title?: string;
    status?: string;
    tokens?: number;
    messages?: number;
    toolCalls?: number;
    contextPercent?: number | null;
  };
  runningTasks: Array<{
    id: string;
    title: string;
    status: string;
    activity?: string;
    progress?: string;
    progressPercent?: number;
    activeMinutes?: number;
    contextTokens?: number | null;
  }>;
  personalTasks: Array<{
    title: string;
    progress: number;
    project?: string;
    dueAt?: number;
  }>;
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function createCompanionWorkRhythm(now = Date.now()): CompanionWorkRhythm {
  return {
    day: localDay(now),
    continuousSince: null,
    lastActiveAt: null,
    lastRestAt: null,
    completedToday: 0,
    failedToday: 0,
    taskStates: {},
  };
}

export function normalizeCompanionWorkRhythm(value: unknown, now = Date.now()): CompanionWorkRhythm {
  const fallback = createCompanionWorkRhythm(now);
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  if (record.day !== localDay(now)) return fallback;
  const finiteOrNull = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : null;
  const taskStates = record.taskStates && typeof record.taskStates === "object"
    ? Object.fromEntries(Object.entries(record.taskStates as Record<string, unknown>)
        .filter(([, status]) => status === "running" || status === "failed")
        .slice(0, 100)) as Record<string, "running" | "failed">
    : {};
  return {
    day: record.day as string,
    continuousSince: finiteOrNull(record.continuousSince),
    lastActiveAt: finiteOrNull(record.lastActiveAt),
    lastRestAt: finiteOrNull(record.lastRestAt),
    completedToday: typeof record.completedToday === "number" ? Math.max(0, Math.floor(record.completedToday)) : 0,
    failedToday: typeof record.failedToday === "number" ? Math.max(0, Math.floor(record.failedToday)) : 0,
    taskStates,
  };
}

export function updateCompanionWorkRhythm(
  current: CompanionWorkRhythm,
  input: { now?: number; active?: boolean; runningTasks?: readonly TaskRuntimeSnapshot[] },
): CompanionWorkRhythm {
  const now = input.now ?? Date.now();
  const state = current.day === localDay(now) ? { ...current, taskStates: { ...current.taskStates } } : createCompanionWorkRhythm(now);
  if (input.active) {
    if (state.lastActiveAt === null || now - state.lastActiveAt >= COMPANION_REST_GAP_MS) {
      if (state.lastActiveAt !== null) state.lastRestAt = now;
      state.continuousSince = now;
    } else {
      state.continuousSince ??= now;
    }
    state.lastActiveAt = now;
  } else if (state.lastActiveAt !== null && now - state.lastActiveAt >= COMPANION_REST_GAP_MS) {
    state.continuousSince = null;
  }

  if (input.runningTasks) {
    const nextStates: Record<string, "running" | "failed"> = {};
    for (const task of input.runningTasks) {
      const status = task.lastPromptFailed || task.taskRun?.phase === "failed" ? "failed" : "running";
      nextStates[task.id] = status;
      if (status === "failed" && state.taskStates[task.id] !== "failed") state.failedToday += 1;
    }
    for (const [id, status] of Object.entries(state.taskStates)) {
      if (status === "running" && !nextStates[id]) state.completedToday += 1;
    }
    state.taskStates = nextStates;
  }
  return state;
}

export function getTaskProgress(snapshot: TaskRuntimeSnapshot): { label?: string; percent?: number } {
  const steps = snapshot.taskRun?.plan?.steps;
  if (steps?.length) {
    const completed = steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
    return { label: `${completed}/${steps.length}`, percent: Math.round(completed / steps.length * 100) };
  }
  return snapshot.taskRun?.progress ? { label: snapshot.taskRun.progress.slice(0, 160) } : {};
}

export function buildCompanionInteractionContext(input: {
  now?: number;
  rhythm: CompanionWorkRhythm;
  session?: CompanionSessionContext | null;
  runningTasks: readonly TaskRuntimeSnapshot[];
  personalTasks: readonly CompanionTodo[];
  includeWorkContext: boolean;
}): CompanionInteractionContext {
  const now = input.now ?? Date.now();
  const continuousSince = input.rhythm.continuousSince;
  const base: CompanionInteractionContext = {
    generatedAt: now,
    continuousWorkMinutes: continuousSince === null ? 0 : Math.max(0, Math.floor((now - continuousSince) / 60_000)),
    minutesSinceLastRest: input.rhythm.lastRestAt === null ? null : Math.max(0, Math.floor((now - input.rhythm.lastRestAt) / 60_000)),
    completedToday: input.rhythm.completedToday,
    failedToday: input.rhythm.failedToday,
    runningTasks: [],
    personalTasks: [],
  };
  if (!input.includeWorkContext) return base;
  const stats = input.session?.stats;
  if (input.session) {
    base.currentSession = {
      ...(input.session.sessionTitle ? { title: input.session.sessionTitle.slice(0, 120) } : {}),
      ...(input.session.status ? { status: input.session.status.slice(0, 40) } : {}),
      ...(stats ? { tokens: stats.tokens.total, messages: stats.totalMessages, toolCalls: stats.toolCalls } : {}),
      contextPercent: input.session.contextUsage?.percent ?? stats?.contextUsage?.percent ?? null,
    };
  }
  base.runningTasks = input.runningTasks.slice(0, 8).map((task) => {
    const progress = getTaskProgress(task);
    return {
      id: task.id.slice(0, 80),
      title: (task.title || task.taskRun?.objective || task.id.slice(0, 8)).slice(0, 160),
      status: (task.taskRun?.phase || task.runtime).slice(0, 40),
      ...(task.activity?.message ? { activity: task.activity.message.slice(0, 180) } : {}),
      ...(progress.label ? { progress: progress.label } : {}),
      ...(progress.percent !== undefined ? { progressPercent: progress.percent } : {}),
      ...(task.startedAt ? { activeMinutes: Math.max(0, Math.floor((now - task.startedAt) / 60_000)) } : {}),
      contextTokens: task.contextUsage?.tokens ?? null,
    };
  });
  base.personalTasks = input.personalTasks
    .filter((task) => !task.completed)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12)
    .map((task) => ({
      title: task.text.slice(0, 160),
      progress: task.progress,
      ...(task.project ? { project: task.project.slice(0, 120) } : {}),
      ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    }));
  return base;
}

export async function requestCompanionSpeech(input: {
  model: CompanionInteractionModel;
  cwd?: string;
  locale: string;
  context: CompanionInteractionContext;
  signal?: AbortSignal;
}): Promise<string> {
  const response = await fetch("/api/companion/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: input.model.provider, modelId: input.model.modelId, cwd: input.cwd, locale: input.locale, context: input.context }),
    signal: input.signal,
  });
  const payload = await response.json().catch(() => null) as { speech?: unknown; error?: unknown } | null;
  if (!response.ok || typeof payload?.speech !== "string") {
    throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
  }
  return payload.speech.trim();
}
