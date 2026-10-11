import { SessionControlStore } from "./session-control-store";
import type { SessionCommandEvent } from "./session-message-types";

type Listener = (event: SessionCommandEvent) => void;

declare global {
  var __pioraSessionCommandEvents: SessionCommandEventHub | undefined;
}
export class SessionCommandEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly store: SessionControlStore = new SessionControlStore()) {}

  async publish(event: Omit<SessionCommandEvent, "cursor">): Promise<SessionCommandEvent> {
    const full = await this.store.appendEvent(event);
    for (const listener of this.listeners.get(full.sessionId) ?? []) {
      try { listener(full); } catch (error) {
        console.error("[pi-web] session command event listener failed:", error instanceof Error ? error.message : error);
      }
    }
    return full;
  }

  list(sessionId: string, afterCursor = 0): SessionCommandEvent[] {
    return this.store.listEvents(sessionId, afterCursor);
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }
}

export function getSessionCommandEventHub(): SessionCommandEventHub {
  return globalThis.__pioraSessionCommandEvents ??= new SessionCommandEventHub();
}

export function resetSessionCommandEventHubForTests(): void {
  globalThis.__pioraSessionCommandEvents = undefined;
}
