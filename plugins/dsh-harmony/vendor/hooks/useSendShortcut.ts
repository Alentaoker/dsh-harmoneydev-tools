"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_SEND_SHORTCUT,
  SEND_SHORTCUT_STORAGE_KEY,
  parseStoredSendShortcut,
  type SendShortcut,
} from "@/lib/send-shortcut";

const listeners = new Set<() => void>();
let currentShortcut: SendShortcut = DEFAULT_SEND_SHORTCUT;
let storageListenerAttached = false;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function commitShortcut(shortcut: SendShortcut, persist: boolean): void {
  currentShortcut = shortcut;
  if (persist) {
    try {
      window.localStorage.setItem(SEND_SHORTCUT_STORAGE_KEY, shortcut);
    } catch {
      // Keep the preference active for this renderer when storage is unavailable.
    }
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListenerAttached && typeof window !== "undefined") {
    storageListenerAttached = true;
    window.addEventListener("storage", (event) => {
      if (event.key !== SEND_SHORTCUT_STORAGE_KEY) return;
      commitShortcut(parseStoredSendShortcut(event.newValue), false);
    });
  }
  return () => listeners.delete(listener);
}

function getSnapshot(): SendShortcut {
  return currentShortcut;
}

function getServerSnapshot(): SendShortcut {
  return DEFAULT_SEND_SHORTCUT;
}

export function useSendShortcut() {
  const shortcut = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    let stored = DEFAULT_SEND_SHORTCUT;
    try {
      stored = parseStoredSendShortcut(window.localStorage.getItem(SEND_SHORTCUT_STORAGE_KEY));
    } catch {
      // Keep the default when storage is unavailable.
    }
    commitShortcut(stored, false);
  }, []);

  const setShortcut = useCallback((next: SendShortcut) => {
    commitShortcut(next, true);
  }, []);

  return { shortcut, setShortcut };
}
