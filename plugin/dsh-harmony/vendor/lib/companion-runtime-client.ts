"use client";

import type { CompanionRuntimeState } from "./companion-runtime";

export const COMPANION_RUNTIME_CHANNEL_NAME = "pi-companion-runtime-v1";
export const COMPANION_RUNTIME_POLL_INTERVAL_MS = 2_000;
export const COMPANION_REQUEST_TIMEOUT_MS = 10_000;

type CompanionRuntimeBroadcast = {
  type: "runtime-state";
  state: CompanionRuntimeState;
};

type CompanionRuntimeError = { error?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function companionRuntimeStateFromBroadcast(value: unknown): CompanionRuntimeState | null {
  if (!isRecord(value) || value.type !== "runtime-state" || !isRecord(value.state)) return null;
  const state = value.state;
  if (
    state.version !== 3
    || typeof state.updatedAt !== "number"
    || !Number.isFinite(state.updatedAt)
    || typeof state.migratedFromLocalStorage !== "boolean"
    || !isRecord(state.settings)
    || !isRecord(state.settings.quietHours)
    || !Array.isArray(state.todos)
    || !Array.isArray(state.taskRecords)
    || !isRecord(state.focusTimer)
    || !isRecord(state.focusTimer.durations)
    || !Array.isArray(state.library)
    || !Array.isArray(state.memories)
    || !isRecord(state.mind)
    || !Array.isArray(state.mind.decisionHistory)
    || (state.mind.lastDecision !== null && !isRecord(state.mind.lastDecision))
  ) {
    return null;
  }
  return state as unknown as CompanionRuntimeState;
}

export function createCompanionRuntimeChannel(
  onState?: (state: CompanionRuntimeState) => void,
): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel(COMPANION_RUNTIME_CHANNEL_NAME);
  if (onState) {
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const state = companionRuntimeStateFromBroadcast(event.data);
      if (state) onState(state);
    });
  }
  return channel;
}

export function publishCompanionRuntimeState(
  channel: BroadcastChannel | null | undefined,
  state: CompanionRuntimeState,
): void {
  channel?.postMessage({ type: "runtime-state", state } satisfies CompanionRuntimeBroadcast);
}

async function requestCompanionRuntimeState(
  init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CompanionRuntimeState> {
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? COMPANION_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("/api/companion/state", { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => null) as CompanionRuntimeState | CompanionRuntimeError | null;
    if (!response.ok || !payload || "error" in payload) {
      throw new Error(payload && "error" in payload && payload.error ? payload.error : `HTTP ${response.status}`);
    }
    return payload as CompanionRuntimeState;
  } catch (cause) {
    if (timedOut) throw new Error("宠物状态请求超时，请稍后重试。");
    throw cause;
  } finally {
    globalThis.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

export function fetchCompanionRuntimeState(options?: {
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CompanionRuntimeState> {
  return requestCompanionRuntimeState({ cache: "no-store" }, options);
}

export function saveCompanionRuntimeState(
  state: CompanionRuntimeState,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<CompanionRuntimeState> {
  return requestCompanionRuntimeState({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  }, options);
}
