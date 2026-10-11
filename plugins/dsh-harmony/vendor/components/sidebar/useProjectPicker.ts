"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export function useProjectPicker({ setSelectedCwd, setRememberedProjectRoots, setHiddenProjectRoots, onProjectSelected }: {
  setSelectedCwd: Dispatch<SetStateAction<string | null>>;
  setRememberedProjectRoots: Dispatch<SetStateAction<Set<string>>>;
  setHiddenProjectRoots: Dispatch<SetStateAction<Set<string>>>;
  onProjectSelected?: (cwd: string) => void;
}) {
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);

  const rememberProject = useCallback((cwd: string) => {
    setRememberedProjectRoots((previous) => previous.has(cwd) ? previous : new Set(previous).add(cwd));
    setHiddenProjectRoots((previous) => {
      if (!previous.has(cwd)) return previous;
      const next = new Set(previous); next.delete(cwd); return next;
    });
  }, [setHiddenProjectRoots, setRememberedProjectRoots]);

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;
    setCustomPathValidating(true); setCustomPathError(null);
    try {
      const response = await fetch("/api/cwd/validate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: path }),
      });
      const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!response.ok || data.error) { setCustomPathError(data.error ?? `HTTP ${response.status}`); return; }
      const cwd = data.cwd ?? path;
      rememberProject(cwd); setSelectedCwd(cwd); onProjectSelected?.(cwd); setCustomPathOpen(false); setCustomPathValue("");
    } catch (error) { setCustomPathError(error instanceof Error ? error.message : String(error)); }
    finally { setCustomPathValidating(false); }
  }, [customPathValidating, customPathValue, onProjectSelected, rememberProject, setSelectedCwd]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathError(null);
    const selectDirectory = window.piDesktop?.selectDirectory;
    if (!selectDirectory) {
      setCustomPathOpen(true);
      return;
    }
    void selectDirectory()
      .then((path) => {
        if (path) void commitCustomPath(path);
      })
      .catch((error: unknown) => {
        setCustomPathError(error instanceof Error ? error.message : String(error));
      });
  }, [commitCustomPath]);
  const handleDefaultCwd = useCallback(async () => {
    try {
      const response = await fetch("/api/default-cwd", { method: "POST" });
      const data = await response.json() as { cwd?: string };
      if (data.cwd) {
        rememberProject(data.cwd); setSelectedCwd(data.cwd); setCustomPathOpen(false);
        setCustomPathValue(""); setCustomPathError(null);
      }
    } catch { /* The picker stays open for another attempt. */ }
  }, [rememberProject, setSelectedCwd]);

  return { customPathOpen, setCustomPathOpen, customPathValue, setCustomPathValue, customPathError, setCustomPathError, customPathValidating, commitCustomPath, handleCustomPathClick, handleDefaultCwd };
}
