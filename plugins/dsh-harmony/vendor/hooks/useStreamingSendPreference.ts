"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_STREAMING_SEND_PREFERENCE,
  STREAMING_SEND_PREFERENCE_STORAGE_KEY,
  normalizeStreamingSendPreference,
  parseStoredStreamingSendPreference,
  serializeStreamingSendPreference,
  type StreamingSendBehavior,
  type StreamingSendPreference,
} from "@/lib/streaming-send-preference";

const listeners = new Set<() => void>();
let currentPreference: StreamingSendPreference = { ...DEFAULT_STREAMING_SEND_PREFERENCE };
let storageListenerAttached = false;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function commitPreference(preference: StreamingSendPreference, persist: boolean): void {
  currentPreference = normalizeStreamingSendPreference(preference);
  if (persist) {
    try {
      window.localStorage.setItem(
        STREAMING_SEND_PREFERENCE_STORAGE_KEY,
        serializeStreamingSendPreference(currentPreference),
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
      if (event.key !== STREAMING_SEND_PREFERENCE_STORAGE_KEY) return;
      commitPreference(parseStoredStreamingSendPreference(event.newValue), false);
    });
  }
  return () => listeners.delete(listener);
}

function getSnapshot(): StreamingSendPreference {
  return currentPreference;
}

function getServerSnapshot(): StreamingSendPreference {
  return DEFAULT_STREAMING_SEND_PREFERENCE;
}

export function useStreamingSendPreference() {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    let stored = { ...DEFAULT_STREAMING_SEND_PREFERENCE };
    try {
      stored = parseStoredStreamingSendPreference(
        window.localStorage.getItem(STREAMING_SEND_PREFERENCE_STORAGE_KEY),
      );
    } catch {
      // Keep the default when storage is unavailable.
    }
    commitPreference(stored, false);
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    commitPreference({ ...currentPreference, enabled }, true);
  }, []);

  const setBehavior = useCallback((behavior: StreamingSendBehavior) => {
    commitPreference({ ...currentPreference, behavior }, true);
  }, []);

  return { preference, setEnabled, setBehavior };
}
