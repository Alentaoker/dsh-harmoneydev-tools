import { DesignToHarmonyError } from "./errors";

export type DesignRunOperationKind = "generate" | "validate";

export interface DesignRunOperationEvent {
  sequence: number;
  runId: string;
  type: "started" | "progress" | "cancelling" | "completed" | "failed" | "cancelled";
  operation: DesignRunOperationKind;
  stage: string;
  message: string;
  timestamp: string;
  progress?: number;
}

type Listener = (event: DesignRunOperationEvent) => void;

interface ActiveOperation {
  kind: DesignRunOperationKind;
  controller: AbortController;
  startedAt: string;
  detachParent: () => void;
}

class DesignRunOperationRegistry {
  private sequence = 0;
  private readonly active = new Map<string, ActiveOperation>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly recent = new Map<string, DesignRunOperationEvent[]>();

  start(runId: string, kind: DesignRunOperationKind, parent?: AbortSignal): AbortController {
    if (this.active.has(runId)) {
      throw new DesignToHarmonyError("PREVIEW_CONFLICT", "Another design operation is already running", { status: 409, retryable: true, stage: kind === "generate" ? "generate" : "build" });
    }
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason);
    if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true });
    const detachParent = () => parent?.removeEventListener("abort", abort);
    controller.signal.addEventListener("abort", detachParent, { once: true });
    this.active.set(runId, { kind, controller, startedAt: new Date().toISOString(), detachParent });
    this.publish(runId, kind, "started", kind, kind === "generate" ? "Generating Harmony preview" : "Validating Harmony output", 0);
    return controller;
  }

  get(runId: string): ActiveOperation | undefined {
    return this.active.get(runId);
  }

  cancel(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active) return false;
    this.publish(runId, active.kind, "cancelling", active.kind, "Cancellation requested");
    active.controller.abort(new DOMException("Design operation cancelled", "AbortError"));
    return true;
  }

  finish(runId: string, type: "completed" | "failed" | "cancelled", stage: string, message: string): void {
    const active = this.active.get(runId);
    if (!active) return;
    this.publish(runId, active.kind, type, stage, message, type === "completed" ? 1 : undefined);
    active.detachParent();
    this.active.delete(runId);
  }

  progress(runId: string, stage: string, message: string, progress?: number): void {
    const active = this.active.get(runId);
    if (!active) return;
    this.publish(runId, active.kind, "progress", stage, message, progress);
  }

  private publish(runId: string, operation: DesignRunOperationKind, type: DesignRunOperationEvent["type"], stage: string, message: string, progress?: number): void {
    const event: DesignRunOperationEvent = {
      sequence: ++this.sequence,
      runId,
      type,
      operation,
      stage: stage.slice(0, 80),
      message: message.slice(0, 500),
      timestamp: new Date().toISOString(),
      ...(progress !== undefined ? { progress: Math.max(0, Math.min(1, progress)) } : {}),
    };
    const history = [...(this.recent.get(runId) ?? []), event].slice(-50);
    this.recent.set(runId, history);
    for (const listener of this.listeners.get(runId) ?? []) {
      try { listener(event); } catch { /* disconnected SSE clients are isolated */ }
    }
  }

  subscribe(runId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(runId);
    };
  }

  events(runId: string, after = 0): DesignRunOperationEvent[] {
    return (this.recent.get(runId) ?? []).filter((event) => event.sequence > after);
  }
}

declare global {
  var __pioraDesignRunOperationRegistry: DesignRunOperationRegistry | undefined;
}

export function getDesignRunOperationRegistry(): DesignRunOperationRegistry {
  return globalThis.__pioraDesignRunOperationRegistry ??= new DesignRunOperationRegistry();
}

export function resetDesignRunOperationRegistryForTests(): void {
  globalThis.__pioraDesignRunOperationRegistry = undefined;
}
