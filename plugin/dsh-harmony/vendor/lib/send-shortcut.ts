export type SendShortcut = "enter" | "ctrl-enter";

export const DEFAULT_SEND_SHORTCUT: SendShortcut = "enter";
export const SEND_SHORTCUT_STORAGE_KEY = "piora-send-shortcut:v1";

export interface SendShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function parseStoredSendShortcut(value: string | null): SendShortcut {
  return value === "ctrl-enter" || value === "enter" ? value : DEFAULT_SEND_SHORTCUT;
}

export function isPlainEnter(event: SendShortcutKeyEvent): boolean {
  return event.key === "Enter"
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && !event.metaKey;
}

export function matchesSendShortcut(
  event: SendShortcutKeyEvent,
  shortcut: SendShortcut,
): boolean {
  if (shortcut === "enter") return isPlainEnter(event);
  return event.key === "Enter"
    && event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && !event.metaKey;
}
