import type { SessionCommandRecord } from "./session-message-types";

export const SESSION_INBOX_LIMIT = 100;
export const SESSION_MESSAGE_TEXT_MAX_BYTES = 256 * 1024;
// A 100 MiB image expands to roughly 133.4 MiB in base64. Keep command and
// queue accounting above that encoded size while retaining the smaller text
// limit enforced by the router.
export const SESSION_COMMAND_MAX_BYTES = 136 * 1024 * 1024;
export const SESSION_INBOX_MAX_BYTES = 160 * 1024 * 1024;

export interface SessionInboxState {
  sessionId: string;
  queue: SessionCommandRecord[];
  queuedBytes: number;
  loaded: boolean;
  draining: boolean;
  drainPromise?: Promise<void>;
}

declare global {
  var __piSessionInboxes: Map<string, SessionInboxState> | undefined;
}

export function sessionCommandBytes(command: SessionCommandRecord): number {
  return Buffer.byteLength(command.content, "utf8") + (command.images ? Buffer.byteLength(JSON.stringify(command.images), "utf8") : 0);
}

export class SessionInboxRegistry {
  constructor(private readonly maxQueue = SESSION_INBOX_LIMIT, private readonly maxBytes = SESSION_INBOX_MAX_BYTES) {}

  private map(): Map<string, SessionInboxState> {
    return globalThis.__piSessionInboxes ??= new Map();
  }

  get(sessionId: string): SessionInboxState {
    const existing = this.map().get(sessionId);
    if (existing) return existing;
    const created: SessionInboxState = { sessionId, queue: [], queuedBytes: 0, loaded: false, draining: false };
    this.map().set(sessionId, created);
    return created;
  }

  enqueue(command: SessionCommandRecord): { position: number } {
    const inbox = this.get(command.targetSessionId);
    const bytes = sessionCommandBytes(command);
    if (bytes > SESSION_COMMAND_MAX_BYTES) throw new Error("SESSION_MESSAGE_TOO_LARGE");
    if (inbox.queue.length >= this.maxQueue || inbox.queuedBytes + bytes > this.maxBytes) throw new Error("SESSION_QUEUE_FULL");
    inbox.queue.push(command);
    inbox.queuedBytes += bytes;
    return { position: inbox.queue.length };
  }

  shift(inbox: SessionInboxState): SessionCommandRecord | undefined {
    const command = inbox.queue.shift();
    if (command) inbox.queuedBytes = Math.max(0, inbox.queuedBytes - sessionCommandBytes(command));
    return command;
  }

  removeCommand(sessionId: string, commandId: string): SessionCommandRecord | undefined {
    const inbox = this.get(sessionId);
    const index = inbox.queue.findIndex((command) => command.commandId === commandId);
    if (index < 0) return undefined;
    const [command] = inbox.queue.splice(index, 1);
    if (command) inbox.queuedBytes = Math.max(0, inbox.queuedBytes - sessionCommandBytes(command));
    return command;
  }

  remove(sessionId: string): void {
    this.map().delete(sessionId);
  }

  clear(): void {
    this.map().clear();
  }
}

export function getSessionInboxRegistry(): SessionInboxRegistry {
  return new SessionInboxRegistry();
}

export function resetSessionInboxesForTests(): void {
  globalThis.__piSessionInboxes?.clear();
}
