"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTaskStatus } from "@/hooks/useTaskStatus";
import type { GitStatusResponse } from "@/lib/git-types";
import { getTrackedGitLineStats } from "@/lib/git-line-stats";
import { STATUS_PRESENTATION, getTaskStatusPresentationKey } from "@/lib/task-status";
import { AliIcon } from "./AliIcon";
import styles from "./TaskHeader.module.css";

interface ProjectHeaderInfo {
  repository?: string;
  branch?: string;
}

interface Props {
  sessionId: string;
  cwd: string;
  taskName: string;
  worktreeBranch?: string;
  busy: boolean;
  compacting: boolean;
  onStop: () => void;
  onOpenChanges: () => void;
  onOpenDetails: () => void;
  onRename: (name: string) => void | Promise<void>;
  onExport: () => void;
}

const EMPTY_GIT_STATUS: GitStatusResponse = {
  isGitRepository: false,
  repositoryRoot: null,
  files: [],
  additions: 0,
  deletions: 0,
};

// TaskHeader is intentionally remounted when the selected task changes. Keep
// the optimistic start time keyed by session until the server snapshot arrives.
const optimisticRunStarts = new Map<string, number>();

function getPathName(path: string): string {
  if (typeof path !== "string") return "";
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${remainder}s`;
}

export function TaskHeader({
  sessionId,
  cwd,
  taskName,
  worktreeBranch,
  busy,
  compacting,
  onStop,
  onOpenChanges,
  onOpenDetails,
  onRename,
  onExport,
}: Props) {
  const { t } = useI18n();
  const [projectInfo, setProjectInfo] = useState<ProjectHeaderInfo>({});
  const [gitStatus, setGitStatus] = useState<GitStatusResponse>(EMPTY_GIT_STATUS);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(taskName);
  const [elapsedMs, setElapsedMs] = useState(0);
  const runStartedAtRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const taskStatus = useTaskStatus({
    sessionId,
    isViewing: true,
    fallbackRuntime: compacting ? "compacting" : busy ? "running" : "idle",
  });
  const presentationKey = getTaskStatusPresentationKey(taskStatus);
  const presentation = STATUS_PRESENTATION[presentationKey];
  const statusColor = presentation.colorVar === "transparent" ? "var(--text-dim)" : `var(${presentation.colorVar})`;
  const active = taskStatus.runtime !== "idle";

  useEffect(() => {
    setRenameValue(taskName);
  }, [taskName]);

  const loadProjectInfo = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/project-info?cwd=${encodeURIComponent(cwd)}`, { signal, cache: "no-store" });
      if (response.ok) setProjectInfo(await response.json() as ProjectHeaderInfo);
    } catch {
      // The cwd label remains useful when project metadata is unavailable.
    }
  }, [cwd]);

  const loadGitStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`, { signal, cache: "no-store" });
      if (response.ok) setGitStatus(await response.json() as GitStatusResponse);
    } catch {
      // Preserve the last successful snapshot until the next refresh.
    }
  }, [cwd]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([loadProjectInfo(controller.signal), loadGitStatus(controller.signal)]);
    return () => controller.abort();
  }, [loadGitStatus, loadProjectInfo]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const changedCwd = (event as CustomEvent<{ cwd?: string }>).detail?.cwd;
      if (!changedCwd || changedCwd === cwd) void loadGitStatus();
    };
    window.addEventListener("piora:git-status-changed", refresh);
    return () => window.removeEventListener("piora:git-status-changed", refresh);
  }, [cwd, loadGitStatus]);

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let stopped = false;
    const schedule = () => {
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), 3_000);
    };
    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      await loadGitStatus(controller.signal);
      schedule();
    };
    const onVisibilityChange = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, loadGitStatus]);

  useEffect(() => {
    if (!active) {
      runStartedAtRef.current = null;
      optimisticRunStarts.delete(sessionId);
      setElapsedMs(0);
      return;
    }
    const authoritativeStart = taskStatus.startedAt;
    const startedAt = authoritativeStart
      ?? optimisticRunStarts.get(sessionId)
      ?? Date.now();
    optimisticRunStarts.set(sessionId, startedAt);
    runStartedAtRef.current = startedAt;
    const update = () => setElapsedMs(Date.now() - (runStartedAtRef.current ?? Date.now()));
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [active, sessionId, taskStatus.startedAt]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const statusLabel = useMemo(() => {
    if (taskStatus.runtime === "compacting") return t("taskHeader.compacting");
    if (taskStatus.runtime === "stopping") return t("taskHeader.stopping");
    return t(presentation.i18nKey);
  }, [presentation.i18nKey, t, taskStatus.runtime]);

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    const nextName = renameValue.trim();
    if (nextName && nextName !== taskName) void onRename(nextName);
    setRenaming(false);
  };

  const branch = worktreeBranch ?? projectInfo.branch;
  const environmentLabel = worktreeBranch ? t("taskHeader.worktree") : null;
  const projectLabel = projectInfo.repository ?? getPathName(cwd);
  const trackedLineStats = useMemo(() => getTrackedGitLineStats(gitStatus), [gitStatus]);

  return (
    <header className={styles.header} aria-label={t("taskHeader.title")}>
      <div className={styles.statusSlot}>
        <button className={styles.slotButton} type="button" onClick={onOpenDetails}>
          <span className={styles.statusDot} style={{ "--task-status-color": statusColor } as CSSProperties} aria-hidden="true" />
          <span className={styles.statusText} style={{ "--task-status-color": statusColor } as CSSProperties}>{statusLabel}</span>
          {active ? <span className={styles.duration}>{formatElapsed(elapsedMs)}</span> : null}
        </button>
      </div>

      <div className={styles.environmentSlot}>
        {renaming ? (
          <form className={styles.renameForm} onSubmit={submitRename}>
            <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-label={t("taskHeader.rename")} />
            <button className={styles.iconButton} type="submit" aria-label={t("taskHeader.saveName")}><AliIcon name="check" size={14} /></button>
          </form>
        ) : (
          <button className={styles.slotButton} type="button" onClick={onOpenDetails} title={[environmentLabel, projectLabel, branch].filter(Boolean).join(" · ")}>
            {environmentLabel ? <><span>{environmentLabel}</span><span className={styles.separator}>·</span></> : null}
            <span className={`${styles.environmentText} ${styles.environmentDetail}`}>{projectLabel}</span>
            {branch ? <><span className={styles.separator}>·</span><span className={styles.environmentText}>{branch}</span></> : null}
          </button>
        )}
      </div>

      <div className={styles.changesSlot}>
        <button className={styles.slotButton} type="button" onClick={onOpenChanges} disabled={!gitStatus.isGitRepository}>
          <span style={{ color: "var(--status-ready)" }}>+{trackedLineStats.additions}</span>
          <span style={{ color: "var(--status-failed)" }}>−{trackedLineStats.deletions}</span>
          <span>{t("taskHeader.files", { count: gitStatus.files.length })}</span>
        </button>
      </div>

      <div className={styles.actions} ref={menuRef}>
        {active ? <button className={styles.stopButton} type="button" onClick={onStop}>{t("taskHeader.stop")}</button> : null}
        <button className={styles.iconButton} type="button" onClick={() => setMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t("taskHeader.more")}>
          <AliIcon name="ellipsis" size={15} />
        </button>
        {menuOpen ? (
          <div className={styles.menu} role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setRenaming(true); }}>{t("taskHeader.rename")}</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onExport(); }}>{t("taskHeader.export")}</button>
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenDetails(); }}>{t("taskHeader.details")}</button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
