import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createSession, parseSessionThinkingLevel } from "./session-creation";
import { getSessionMessageRouter } from "./session-message-router";
import type { SessionCommandStatus } from "./session-message-types";
import { getAutomationStore, type AutomationStore } from "./automation-store";
import type { AutomationDefinition, AutomationRun } from "./automation-types";

const TERMINAL = new Set<SessionCommandStatus>(["completed", "failed", "cancelled", "expired", "interrupted"]);
const TICK_INTERVAL_MS = 15_000;
const COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function modelSelection(value?: string): { provider: string; modelId: string } | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error("Automation model must use provider/modelId format.");
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

async function waitForCommand(commandId: string, sessionId: string): Promise<{ status: SessionCommandStatus; error?: string }> {
  const router = getSessionMessageRouter();
  const current = await router.getCommand(commandId);
  if (TERMINAL.has(current.status)) return { status: current.status, ...(current.errorMessage ? { error: current.errorMessage } : {}) };
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (status: SessionCommandStatus, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolvePromise({ status, ...(error ? { error } : {}) });
    };
    const unsubscribe = router.subscribeEvents(sessionId, (event) => {
      if (event.commandId === commandId && event.status && TERMINAL.has(event.status)) finish(event.status, event.errorMessage);
    });
    const timeout = setTimeout(() => finish("failed", "Automation command timed out after 24 hours."), COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    void router.getCommand(commandId).then((latest) => {
      if (TERMINAL.has(latest.status)) finish(latest.status, latest.errorMessage);
    }).catch((error) => finish("failed", safeError(error)));
  });
}

interface AutomationRuntimeOptions {
  store?: AutomationStore;
  now?: () => number;
  tickIntervalMs?: number;
  disableTimer?: boolean;
}

export class AutomationRuntime {
  private readonly store: AutomationStore;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private readonly inFlight = new Set<string>();
  private timer?: NodeJS.Timeout;
  private started = false;

  constructor(options: AutomationRuntimeOptions = {}) {
    this.store = options.store ?? getAutomationStore();
    this.now = options.now ?? Date.now;
    this.tickIntervalMs = Math.max(1_000, options.tickIntervalMs ?? TICK_INTERVAL_MS);
    if (!options.disableTimer) this.start();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.store.recoverInterrupted(this.now()).then(() => this.tick()).catch((error) => console.error("[piora-automations] recovery failed:", safeError(error)));
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  async tick(): Promise<void> {
    const now = this.now();
    const due = this.store.list().filter((item) => item.status === "ACTIVE" && item.nextRunAt !== null && item.nextRunAt <= now && !item.running);
    await Promise.all(due.map(async (automation) => {
      if (this.inFlight.has(automation.id)) return;
      const scheduledFor = automation.nextRunAt!;
      // Advance before dispatch so a failed process cannot create a rapid duplicate loop.
      await this.store.advanceSchedule(automation.id, Math.max(now, scheduledFor), now);
      await this.launch(automation, scheduledFor);
    }));
  }

  async runNow(id: string): Promise<AutomationRun> {
    const automation = this.store.get(id);
    if (!automation) throw new Error("Automation not found.");
    if (this.inFlight.has(id) || automation.running) throw new Error("Automation is already running.");
    return this.launch(automation, this.now());
  }

  private async launch(automation: AutomationDefinition, scheduledFor: number): Promise<AutomationRun> {
    if (this.inFlight.has(automation.id)) throw new Error("Automation is already running.");
    this.inFlight.add(automation.id);
    const run = await this.store.startRun(automation.id, scheduledFor, this.now());
    if (run.status !== "queued") {
      this.inFlight.delete(automation.id);
      return run;
    }
    void this.execute(automation, run).finally(() => this.inFlight.delete(automation.id));
    return run;
  }

  private async execute(automation: AutomationDefinition, run: AutomationRun): Promise<void> {
    const startedAt = this.now();
    await this.store.updateRun(run.id, { status: "running", startedAt });
    let notificationSessionId = automation.target.type === "session" ? automation.target.sessionId : undefined;
    try {
      let sessionId: string;
      if (automation.target.type === "session") {
        sessionId = automation.target.sessionId;
      } else {
        const cwd = resolve(automation.target.cwd);
        if (!statSync(cwd).isDirectory()) throw new Error(`Automation project directory does not exist: ${cwd}`);
        const created = await createSession({
          cwd,
          name: automation.name,
          ...(modelSelection(automation.model) ? { initialModel: modelSelection(automation.model) } : {}),
          ...(automation.reasoningEffort ? { thinkingLevel: parseSessionThinkingLevel(automation.reasoningEffort) } : {}),
        });
        sessionId = created.sessionId;
      }
      notificationSessionId = sessionId;
      const receipt = await getSessionMessageRouter().dispatchSessionMessage({
        targetSessionId: sessionId,
        content: automation.prompt,
        delivery: "next_turn",
        source: "system",
        idempotencyKey: `automation:${automation.id}:${run.id}`,
        expiresAt: this.now() + COMMAND_TIMEOUT_MS,
      });
      await this.store.updateRun(run.id, { sessionId, commandId: receipt.commandId });
      const terminal = await waitForCommand(receipt.commandId, sessionId);
      const succeeded = terminal.status === "completed";
      const status = succeeded ? "succeeded" : terminal.status === "cancelled" ? "cancelled" : terminal.status === "interrupted" ? "interrupted" : "failed";
      await this.store.updateRun(run.id, { status, completedAt: this.now(), ...(terminal.error ? { error: terminal.error } : {}) });
      if (this.shouldNotify(automation, status)) {
        await this.store.addNotification({
          id: `notice_${randomUUID()}`,
          automationId: automation.id,
          runId: run.id,
          sessionId,
          title: automation.name,
          status: status === "succeeded" ? "succeeded" : status === "interrupted" ? "interrupted" : "failed",
          createdAt: this.now(),
        });
      }
    } catch (error) {
      await this.store.updateRun(run.id, { status: "failed", completedAt: this.now(), error: safeError(error) });
      if (this.shouldNotify(automation, "failed")) {
        await this.store.addNotification({
          id: `notice_${randomUUID()}`,
          automationId: automation.id,
          runId: run.id,
          ...(notificationSessionId ? { sessionId: notificationSessionId } : {}),
          title: automation.name,
          status: "failed",
          createdAt: this.now(),
        });
      }
    }
  }

  private shouldNotify(automation: AutomationDefinition, status: AutomationRun["status"]): boolean {
    if (automation.notificationPolicy === "never") return false;
    if (automation.notificationPolicy === "failed_runs_only") return status !== "succeeded";
    return status === "succeeded" || status === "failed" || status === "interrupted";
  }
}

declare global { var __pioraAutomationRuntime: AutomationRuntime | undefined; }

export function getAutomationRuntime(): AutomationRuntime {
  return globalThis.__pioraAutomationRuntime ??= new AutomationRuntime();
}

export function startAutomationRuntime(): void {
  getAutomationRuntime();
}

export function resetAutomationRuntimeForTests(): void {
  globalThis.__pioraAutomationRuntime?.stop();
  globalThis.__pioraAutomationRuntime = undefined;
}
