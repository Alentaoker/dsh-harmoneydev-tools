"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROJECT_NOTIFICATION_CHANGE_EVENT,
  PROJECT_NOTIFICATION_STORAGE_KEY,
  isProjectNotificationMuted,
  normalizeNotificationProjectRoot,
  parseMutedProjectRoots,
  serializeMutedProjectRoots,
} from "@/lib/project-notification-preferences";

function readMutedProjectRoots(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return parseMutedProjectRoots(window.localStorage.getItem(PROJECT_NOTIFICATION_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

export function useProjectNotificationPreferences() {
  const [mutedProjectRoots, setMutedProjectRoots] = useState<Set<string>>(readMutedProjectRoots);
  const mutedProjectRootsRef = useRef(mutedProjectRoots);
  mutedProjectRootsRef.current = mutedProjectRoots;

  useEffect(() => {
    const refresh = () => {
      const next = readMutedProjectRoots();
      mutedProjectRootsRef.current = next;
      setMutedProjectRoots(next);
    };
    window.addEventListener("storage", refresh);
    window.addEventListener(PROJECT_NOTIFICATION_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(PROJECT_NOTIFICATION_CHANGE_EVENT, refresh);
    };
  }, []);

  const setProjectMuted = useCallback((projectRoot: string, muted: boolean) => {
    const normalized = normalizeNotificationProjectRoot(projectRoot);
    if (!normalized) return;
    const next = new Set(mutedProjectRootsRef.current);
    if (muted) next.add(normalized); else next.delete(normalized);
    mutedProjectRootsRef.current = next;
    setMutedProjectRoots(next);
    try {
      window.localStorage.setItem(PROJECT_NOTIFICATION_STORAGE_KEY, serializeMutedProjectRoots(next));
      window.dispatchEvent(new Event(PROJECT_NOTIFICATION_CHANGE_EVENT));
    } catch {
      // The preference still applies for this window when storage is unavailable.
    }
  }, []);

  const toggleProjectMuted = useCallback((projectRoot: string) => {
    setProjectMuted(projectRoot, !isProjectNotificationMuted(mutedProjectRootsRef.current, projectRoot));
  }, [setProjectMuted]);

  return { mutedProjectRoots, setProjectMuted, toggleProjectMuted };
}
