import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { assertValidAutomationSchedule, nextAutomationOccurrence, normalizeRRule, systemTimezone, validateTimezone } from "./automation-schedule";
import type {
  AutomationDefinition,
  AutomationNotification,
  AutomationRun,
  AutomationSummary,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "./automation-types";
import { writePrivateFileAtomicSync } from "./atomic-file";

interface AutomationStateFile {
  version: 1;
  automations: AutomationDefinition[];
  runs: AutomationRun[];
  notifications: AutomationNotification[];
}

const EMPTY_STATE: AutomationStateFile = { version: 1, automations: [], runs: [], notifications: [] };
const MAX_RUNS_PER_AUTOMATION = 200;
const MAX_NOTIFICATIONS = 500;

function copyState(state: AutomationStateFile): AutomationStateFile {
  return JSON.parse(JSON.stringify(state)) as AutomationStateFile;
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} is too long.`);
  return normalized;
}

function validateTarget(input: CreateAutomationInput["target"]): CreateAutomationInput["target"] {
  if (!input || (input.type !== "session" && input.type !== "project")) throw new Error("A valid automation target is required.");
  if (input.type === "session") {
    return {
      type: "session",
      sessionId: boundedText(input.sessionId, "sessionId", 512),
      ...(typeof input.cwd === "string" && input.cwd.trim() ? { cwd: resolve(input.cwd) } : {}),
      ...(typeof input.sessionName === "string" && input.sessionName.trim() ? { sessionName: input.sessionName.trim().slice(0, 200) } : {}),
    };
  }
  return { type: "project", cwd: resolve(boundedText(input.cwd, "cwd", 4_096)) };
}

function normalizeInput(input: CreateAutomationInput, now: number): Omit<AutomationDefinition, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const timezone = validateTimezone(input.timezone ?? systemTimezone());
  const rrule = normalizeRRule(input.rrule);
  assertValidAutomationSchedule(rrule, now, timezone);
  const target = validateTarget(input.target);
  const kind = input.kind;
  if ((kind === "heartbeat") !== (target.type === "session")) throw new Error("Heartbeat automations require a Session target; cron automations require a Project target.");
  const notificationPolicy = input.notificationPolicy ?? "important_updates";
  if (!["always", "important_updates", "failed_runs_only", "never"].includes(notificationPolicy)) throw new Error("Invalid notification policy.");
  return {
    version: 1,
    kind,
    name: boundedText(input.name, "name", 200),
    prompt: boundedText(input.prompt, "prompt", 100_000),
    status: input.status ?? "ACTIVE",
    rrule,
    timezone,
    target,
    notificationPolicy,
    ...(input.model?.trim() ? { model: input.model.trim().slice(0, 300) } : {}),
    ...(input.reasoningEffort?.trim() ? { reasoningEffort: input.reasoningEffort.trim().slice(0, 30) } : {}),
  };
}

export function automationStorePath(root = join(getAgentDir(), "piora", "automations")): string {
  return resolve(root, "state.json");
}

export class AutomationStore {
  readonly filePath: string;
  private mutation = Promise.resolve();

  constructor(root?: string) {
    this.filePath = automationStorePath(root);
  }

  private read(): AutomationStateFile {
    if (!existsSync(this.filePath)) return copyState(EMPTY_STATE);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as AutomationStateFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.automations) || !Array.isArray(parsed.runs) || !Array.isArray(parsed.notifications)) throw new Error("unsupported state");
      return parsed;
    } catch (error) {
      throw new Error(`Automation state is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private write(state: AutomationStateFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async mutate<T>(operation: (state: AutomationStateFile) => T): Promise<T> {
    let result!: T;
    const next = this.mutation.then(() => {
      const state = this.read();
      result = operation(state);
      this.write(state);
    });
    this.mutation = next.catch(() => undefined);
    await next;
    return result;
  }

  list(): AutomationSummary[] {
    const state = this.read();
    return state.automations.map((automation) => {
      const latestRun = state.runs.filter((run) => run.automationId === automation.id).sort((a, b) => b.createdAt - a.createdAt)[0];
      return { ...automation, ...(latestRun ? { latestRun } : {}), running: latestRun?.status === "queued" || latestRun?.status === "running" };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): AutomationSummary | undefined {
    return this.list().find((item) => item.id === id);
  }

  listRuns(automationId: string, limit = 50): AutomationRun[] {
    return this.read().runs.filter((run) => run.automationId === automationId).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(200, limit)));
  }

  async create(input: CreateAutomationInput, now = Date.now()): Promise<AutomationDefinition> {
    const normalized = normalizeInput(input, now);
    return this.mutate((state) => {
      const base = normalized.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "automation";
      let id = base;
      let suffix = 2;
      while (state.automations.some((item) => item.id === id)) id = `${base}-${suffix++}`;
      const definition: AutomationDefinition = {
        ...normalized,
        id,
        createdAt: now,
        updatedAt: now,
        // A newly-created recurring task starts after its first complete
        // interval. Running it immediately is surprising for schedules such as
        // "every 5 minutes" and can dispatch before the user finishes editing.
        nextRunAt: normalized.status === "ACTIVE" ? nextAutomationOccurrence(normalized.rrule, now, now, normalized.timezone) : null,
      };
      state.automations.push(definition);
      return { ...definition };
    });
  }

  async update(id: string, patch: UpdateAutomationInput, now = Date.now()): Promise<AutomationDefinition> {
    return this.mutate((state) => {
      const index = state.automations.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Automation not found.");
      const current = state.automations[index];
      const normalized = normalizeInput({
        kind: patch.kind ?? current.kind,
        name: patch.name ?? current.name,
        prompt: patch.prompt ?? current.prompt,
        status: patch.status ?? current.status,
        rrule: patch.rrule ?? current.rrule,
        timezone: patch.timezone ?? current.timezone,
        target: patch.target ?? current.target,
        notificationPolicy: patch.notificationPolicy ?? current.notificationPolicy,
        model: patch.model ?? current.model,
        reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
      }, current.createdAt);
      const scheduleChanged = normalized.rrule !== current.rrule || normalized.timezone !== current.timezone || normalized.status !== current.status;
      const updated: AutomationDefinition = {
        ...current,
        ...normalized,
        updatedAt: now,
        nextRunAt: normalized.status === "ACTIVE"
          ? (scheduleChanged ? nextAutomationOccurrence(normalized.rrule, now, current.createdAt, normalized.timezone) : current.nextRunAt)
          : null,
      };
      state.automations[index] = updated;
      return { ...updated };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const before = state.automations.length;
      state.automations = state.automations.filter((item) => item.id !== id);
      state.notifications = state.notifications.filter((item) => item.automationId !== id);
      return state.automations.length !== before;
    });
  }

  async startRun(automationId: string, scheduledFor: number, now = Date.now()): Promise<AutomationRun> {
    return this.mutate((state) => {
      const automation = state.automations.find((item) => item.id === automationId);
      if (!automation) throw new Error("Automation not found.");
      const existing = state.runs.find((run) => run.automationId === automationId && run.scheduledFor === scheduledFor);
      if (existing) return { ...existing };
      const run: AutomationRun = { id: `run_${randomUUID()}`, automationId, scheduledFor, createdAt: now, status: "queued" };
      state.runs.push(run);
      return { ...run };
    });
  }

  async updateRun(runId: string, patch: Partial<AutomationRun>): Promise<AutomationRun> {
    return this.mutate((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) throw new Error("Automation run not found.");
      Object.assign(run, patch, { id: run.id, automationId: run.automationId });
      const automationRuns = state.runs.filter((item) => item.automationId === run.automationId).sort((a, b) => b.createdAt - a.createdAt);
      const keep = new Set(automationRuns.slice(0, MAX_RUNS_PER_AUTOMATION).map((item) => item.id));
      state.runs = state.runs.filter((item) => item.automationId !== run.automationId || keep.has(item.id));
      return { ...run };
    });
  }

  async advanceSchedule(id: string, after: number, lastRunAt: number): Promise<AutomationDefinition> {
    return this.mutate((state) => {
      const automation = state.automations.find((item) => item.id === id);
      if (!automation) throw new Error("Automation not found.");
      automation.lastRunAt = lastRunAt;
      automation.updatedAt = Date.now();
      automation.nextRunAt = automation.status === "ACTIVE"
        ? nextAutomationOccurrence(automation.rrule, after, automation.createdAt, automation.timezone)
        : null;
      return { ...automation };
    });
  }

  async recoverInterrupted(now = Date.now()): Promise<number> {
    return this.mutate((state) => {
      let count = 0;
      for (const run of state.runs) {
        if (run.status !== "queued" && run.status !== "running") continue;
        run.status = "interrupted";
        run.completedAt = now;
        run.error = "Piora stopped before this automation run could be proven complete.";
        count += 1;
      }
      return count;
    });
  }

  async addNotification(notification: AutomationNotification): Promise<void> {
    await this.mutate((state) => {
      if (!state.notifications.some((item) => item.id === notification.id)) state.notifications.push(notification);
      state.notifications = state.notifications.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_NOTIFICATIONS);
    });
  }

  pendingNotifications(limit = 20): AutomationNotification[] {
    return this.read().notifications.filter((item) => !item.deliveredAt).sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(1, Math.min(100, limit)));
  }

  async acknowledgeNotifications(ids: string[], now = Date.now()): Promise<number> {
    const wanted = new Set(ids);
    return this.mutate((state) => {
      let count = 0;
      for (const item of state.notifications) {
        if (!item.deliveredAt && wanted.has(item.id)) { item.deliveredAt = now; count += 1; }
      }
      return count;
    });
  }
}

declare global { var __pioraAutomationStore: AutomationStore | undefined; }

export function getAutomationStore(): AutomationStore {
  return globalThis.__pioraAutomationStore ??= new AutomationStore();
}

export function resetAutomationStoreForTests(): void {
  globalThis.__pioraAutomationStore = undefined;
}
