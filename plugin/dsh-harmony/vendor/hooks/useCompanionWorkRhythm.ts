"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMPANION_REST_GAP_MS,
  COMPANION_WORK_RHYTHM_STORAGE_KEY,
  createCompanionWorkRhythm,
  normalizeCompanionWorkRhythm,
  updateCompanionWorkRhythm,
  type CompanionWorkRhythm,
} from "@/lib/companion-interaction";
import type { TaskRuntimeSnapshot } from "@/lib/task-status";

function readRhythm(): CompanionWorkRhythm {
  try {
    return normalizeCompanionWorkRhythm(JSON.parse(window.localStorage.getItem(COMPANION_WORK_RHYTHM_STORAGE_KEY) || "null"));
  } catch {
    return createCompanionWorkRhythm();
  }
}

export function useCompanionWorkRhythm(runningTasks: readonly TaskRuntimeSnapshot[]): CompanionWorkRhythm {
  const [rhythm, setRhythm] = useState<CompanionWorkRhythm>(() => createCompanionWorkRhythm());
  const tasksRef = useRef(runningTasks);
  tasksRef.current = runningTasks;
  const taskStateKey = JSON.stringify(runningTasks.map((task) => [
    task.id,
    task.runtime,
    task.lastPromptFailed,
    task.taskRun?.phase,
  ]));

  const commit = useCallback((active: boolean) => {
    setRhythm((current) => {
      const next = updateCompanionWorkRhythm(current, { active, runningTasks: tasksRef.current });
      try { window.localStorage.setItem(COMPANION_WORK_RHYTHM_STORAGE_KEY, JSON.stringify(next)); } catch { /* memory-only fallback */ }
      return next;
    });
  }, []);

  useEffect(() => {
    const restored = updateCompanionWorkRhythm(readRhythm(), { active: true, runningTasks });
    setRhythm(restored);
    try { window.localStorage.setItem(COMPANION_WORK_RHYTHM_STORAGE_KEY, JSON.stringify(restored)); } catch { /* memory-only fallback */ }
    // Initial hydration owns the first task reconciliation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    commit(document.visibilityState === "visible");
  }, [commit, taskStateKey]);

  useEffect(() => {
    let lastRecordedAt = 0;
    const markActive = () => {
      const now = Date.now();
      if (now - lastRecordedAt < 30_000) return;
      lastRecordedAt = now;
      commit(true);
    };
    const markVisibility = () => commit(document.visibilityState === "visible");
    window.addEventListener("pointerdown", markActive, { passive: true });
    window.addEventListener("keydown", markActive);
    window.addEventListener("focus", markActive);
    document.addEventListener("visibilitychange", markVisibility);
    const timer = window.setInterval(() => commit(document.visibilityState === "visible"), Math.min(60_000, COMPANION_REST_GAP_MS));
    return () => {
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("keydown", markActive);
      window.removeEventListener("focus", markActive);
      document.removeEventListener("visibilitychange", markVisibility);
      window.clearInterval(timer);
    };
  }, [commit]);

  return rhythm;
}
