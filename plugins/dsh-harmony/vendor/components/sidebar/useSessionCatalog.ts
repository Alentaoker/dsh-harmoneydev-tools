"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRunningTaskRuntimeState } from "@/hooks/useTaskStatus";
import type { SessionInfo } from "@/lib/types";
import { filterMutedSessionIds } from "@/lib/project-notification-preferences";
import { loadUnreadSessionIds, saveUnreadSessionIds } from "./sidebar-utils";

export interface SessionCompletionAnnouncement {
  count: number;
  title: string;
}

export function useSessionCatalog({ selectedSessionId, refreshKey, mutedProjectRoots }: { selectedSessionId: string | null; refreshKey?: number; mutedProjectRoots: ReadonlySet<string> }) {
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fallbackRunningSessionIds, setFallbackRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const [completionAnnouncement, setCompletionAnnouncement] = useState<SessionCompletionAnnouncement | null>(null);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const loadSessionsRequestIdRef = useRef(0);
  const runtimeState = useRunningTaskRuntimeState();
  const runningSessionIds = useMemo(() => {
    if (!runtimeState.ready) return fallbackRunningSessionIds;
    return new Set(runtimeState.snapshots
      .filter((snapshot) => snapshot.runtime !== "idle")
      .map((snapshot) => snapshot.id));
  }, [fallbackRunningSessionIds, runtimeState]);

  const loadSessions = useCallback(async (showLoading = false) => {
    const requestId = ++loadSessionsRequestIdRef.current;
    try {
      if (showLoading) setLoading(true);
      const response = await fetch("/api/sessions");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
      if (loadSessionsRequestIdRef.current !== requestId) return;
      setAllSessions(data.sessions);
      setFallbackRunningSessionIds(new Set(data.runningSessionIds ?? []));
      const existingIds = new Set(data.sessions.map((session) => session.id));
      setUnreadSessionIds((previous) => {
        if (previous.size === 0) return previous;
        const next = new Set([...previous].filter((id) => existingIds.has(id)));
        return next.size === previous.size ? previous : next;
      });
      setError(null);
    } catch (caught) {
      if (loadSessionsRequestIdRef.current === requestId) setError(String(caught));
    } finally {
      // A background refresh can supersede the initial, loading-visible request
      // (for example when a room member finishes while the sidebar mounts).
      // Whichever request is newest owns settlement, even if it did not itself
      // turn the loading indicator on.
      if (loadSessionsRequestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const first = !initialLoadDone.current;
    initialLoadDone.current = true;
    void loadSessions(first);
  }, [loadSessions, refreshKey]);

  useEffect(() => { saveUnreadSessionIds(unreadSessionIds); }, [unreadSessionIds]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completed = [...previous].filter((id) => !runningSessionIds.has(id));
    const completedWithPrompts = filterMutedSessionIds(completed, allSessions, mutedProjectRoots);
    const unreadCompleted = completedWithPrompts.filter((id) => id !== selectedSessionId);
    if (completedWithPrompts.length > 0) {
      const latestId = completedWithPrompts[completedWithPrompts.length - 1];
      const latest = allSessions.find((session) => session.id === latestId);
      setCompletionAnnouncement({
        count: completedWithPrompts.length,
        title: latest?.name || latest?.firstMessage.slice(0, 80) || latestId.slice(0, 12),
      });
    } else if (completed.length > 0 || runningSessionIds.size > 0) {
      setCompletionAnnouncement(null);
    }
    if (unreadCompleted.length > 0 || runningSessionIds.size > 0) {
      setUnreadSessionIds((current) => {
        const next = new Set(current);
        runningSessionIds.forEach((id) => next.delete(id));
        unreadCompleted.forEach((id) => next.add(id));
        return next;
      });
    }
    if (completed.length > 0) {
      const completedIds = new Set(completed);
      const modified = new Date().toISOString();
      setAllSessions((current) => current.map((session) => (
        completedIds.has(session.id) ? { ...session, modified } : session
      )));
    }
    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [allSessions, mutedProjectRoots, runningSessionIds, selectedSessionId]);

  useEffect(() => {
    setUnreadSessionIds((previous) => {
      const next = new Set(filterMutedSessionIds(previous, allSessions, mutedProjectRoots));
      return next.size === previous.size ? previous : next;
    });
  }, [allSessions, mutedProjectRoots]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((previous) => {
      if (!previous.has(selectedSessionId)) return previous;
      const next = new Set(previous); next.delete(selectedSessionId); return next;
    });
  }, [selectedSessionId]);

  const markSessionUnread = useCallback((sessionId: string) => {
    setUnreadSessionIds((previous) => {
      if (previous.has(sessionId)) return previous;
      const next = new Set(previous);
      next.add(sessionId);
      return next;
    });
  }, []);

  return { allSessions, loading, error, runningSessionIds, unreadSessionIds, completionAnnouncement, loadSessions, markSessionUnread };
}
