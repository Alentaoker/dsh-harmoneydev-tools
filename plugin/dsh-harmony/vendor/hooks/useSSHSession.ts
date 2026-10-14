"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SSHSessionEvent, SSHSessionSnapshot } from "@/lib/ssh/types";
import { sshRequest, SSHRequestError } from "@/lib/ssh/client";

/** One SSE connection for both metadata and xterm. Only the session id is stored. */
export function useSSHSession(scope: string, explicitId?: string | null) {
  const storageKey = `piora:ssh:v1:${scope}`;
  const [snapshot, setSnapshot] = useState<SSHSessionSnapshot | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const current = useRef<SSHSessionSnapshot | null>(null);
  const listeners = useRef(new Set<(event: SSHSessionEvent) => void>());
  const receive = useCallback((event: SSHSessionEvent) => {
    const previous = current.current;
    if (event.type === "snapshot") current.current = event.snapshot;
    else if (previous) {
      if (event.type === "output") current.current = { ...previous, output: (previous.output + event.data).slice(-500_000) };
      else if (event.type === "status") current.current = { ...previous, connected: event.connected };
      else if (event.type === "cwd") current.current = { ...previous, cwd: event.cwd };
      else if (event.type === "busy") current.current = { ...previous, busy: event.busy };
      else if (event.type === "clear") current.current = { ...previous, output: "" };
    }
    if (event.type !== "output") setSnapshot(current.current ? { ...current.current, output: "" } : null);
    for (const listener of listeners.current) listener(event);
  }, []);
  const remember = useCallback((value: SSHSessionSnapshot | null) => {
    try { if (value) sessionStorage.setItem(storageKey, value.id); else if (explicitId === undefined) sessionStorage.removeItem(storageKey); } catch { /* Storage may be disabled. */ }
    if (value) receive({ type: "snapshot", snapshot: value });
    else { current.current = null; setSnapshot(null); setStreamReady(false); }
  }, [receive, storageKey, explicitId]);
  const subscribe = useCallback((listener: (event: SSHSessionEvent) => void) => {
    listeners.current.add(listener);
    if (current.current) listener({ type: "snapshot", snapshot: current.current });
    return () => { listeners.current.delete(listener); };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      setRestoring(true); setRestoreError(false);
      try {
        let id: string | null = explicitId ?? null;
        if (explicitId === undefined) try { id = sessionStorage.getItem(storageKey); } catch { /* No saved session. */ }
        if (id) {
          const result = await sshRequest<{ snapshot: SSHSessionSnapshot }>(`/api/ssh/sessions/${encodeURIComponent(id)}`, { signal: abort.signal });
          if (!abort.signal.aborted) receive({ type: "snapshot", snapshot: result.snapshot });
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          if (error instanceof SSHRequestError && error.status === 404) remember(null);
          else setRestoreError(true);
        }
      } finally { if (!abort.signal.aborted) setRestoring(false); }
    })();
    return () => abort.abort();
  }, [storageKey, explicitId, receive, remember, restoreAttempt]);
  const id = snapshot?.id;
  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    const source = new EventSource(`/api/ssh/sessions/${encodeURIComponent(id)}/events`);
    source.onmessage = event => {
      try { receive(JSON.parse(event.data) as SSHSessionEvent); setStreamReady(true); }
      catch { /* The next snapshot reconciles malformed frames. */ }
    };
    source.onerror = () => {
      setStreamReady(false);
      // A restarted server has no session to resume; stop EventSource's endless
      // 404 retries but preserve the visible terminal until the user leaves it.
      void sshRequest(`/api/ssh/sessions/${encodeURIComponent(id)}`, { signal: abort.signal }).catch(error => {
        if (!abort.signal.aborted && error instanceof SSHRequestError && error.status === 404) {
          source.close(); receive({ type: "status", connected: false }); setStreamReady(true);
        }
      });
    };
    return () => { abort.abort(); source.close(); };
  }, [id, receive]);
  return { snapshot, restoring, restoreError, streamReady, remember, subscribe, retryRestore: () => setRestoreAttempt(value => value + 1) };
}
