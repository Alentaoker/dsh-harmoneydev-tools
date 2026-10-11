"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_LIVE_OUTPUT_AUTO_SCROLL,
  LIVE_OUTPUT_AUTO_SCROLL_STORAGE_KEY,
  parseStoredLiveOutputAutoScroll,
  serializeLiveOutputAutoScroll,
} from "@/lib/live-output-auto-scroll";

const listeners = new Set<() => void>();
let currentEnabled = DEFAULT_LIVE_OUTPUT_AUTO_SCROLL;
let storageListenerAttached = false;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function commitEnabled(enabled: boolean, persist: boolean): void {
  currentEnabled = enabled;
  if (persist) {
    try {
      window.localStorage.setItem(
        LIVE_OUTPUT_AUTO_SCROLL_STORAGE_KEY,
        serializeLiveOutputAutoScroll(enabled),
      );
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
      if (event.key !== LIVE_OUTPUT_AUTO_SCROLL_STORAGE_KEY) return;
      commitEnabled(parseStoredLiveOutputAutoScroll(event.newValue), false);
    });
  }
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return currentEnabled;
}

export function useLiveOutputAutoScrollPreference() {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_LIVE_OUTPUT_AUTO_SCROLL);

  useEffect(() => {
    let stored = DEFAULT_LIVE_OUTPUT_AUTO_SCROLL;
    try {
      stored = parseStoredLiveOutputAutoScroll(
        window.localStorage.getItem(LIVE_OUTPUT_AUTO_SCROLL_STORAGE_KEY),
      );
    } catch {
      // Keep the default when storage is unavailable.
    }
    commitEnabled(stored, false);
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    commitEnabled(nextEnabled, true);
  }, []);

  return { enabled, setEnabled };
}
