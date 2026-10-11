"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRunningTaskSnapshots } from "@/hooks/useTaskStatus";
import { deriveCompanionTaskPresentation } from "@/lib/companion-behavior";
import { getTaskProgress } from "@/lib/companion-interaction";
import {
  formatCompanionFocusCountdown,
  getCompanionFocusPetPresentation,
} from "@/lib/companion-focus-timer";
import {
  createCompanionRuntimeChannel,
  fetchCompanionRuntimeState,
} from "@/lib/companion-runtime-client";
import type { CompanionDecision, CompanionFocusTimer, CompanionRuntimeState } from "@/lib/companion-runtime";
import styles from "./CompanionBubbleWindow.module.css";

const TASK_STATUS_COLORS = {
  idle: "var(--status-ready)",
  running: "var(--status-running)",
  waiting: "var(--status-attention)",
  review: "var(--status-attention)",
  failed: "var(--status-failed)",
} as const;

export function CompanionBubbleWindow() {
  const { t } = useI18n();
  const runningTasks = useRunningTaskSnapshots();
  const [taskPage, setTaskPage] = useState(0);
  const [decision, setDecision] = useState<CompanionDecision | null>(null);
  const [decisionVisible, setDecisionVisible] = useState(false);
  const [focusTimer, setFocusTimer] = useState<CompanionFocusTimer | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const latestUpdatedAtRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const controller = new AbortController();
    const applyDecision = (next: CompanionDecision | null) => {
      setDecision(next);
      setDecisionVisible(Boolean(next?.speech && Date.now() - next.createdAt < 18_000));
    };
    const applyState = (state: CompanionRuntimeState) => {
      if (state.updatedAt < latestUpdatedAtRef.current) return;
      latestUpdatedAtRef.current = state.updatedAt;
      setFocusTimer(state.focusTimer);
      applyDecision(state.mind.lastDecision);
    };
    const channel = createCompanionRuntimeChannel(applyState);
    void fetchCompanionRuntimeState({ signal: controller.signal })
      .then(applyState)
      .catch(() => undefined);
    return () => {
      controller.abort();
      channel?.close();
    };
  }, []);

  useEffect(() => {
    if (!decisionVisible) return;
    const timer = window.setTimeout(() => setDecisionVisible(false), 18_000);
    return () => window.clearTimeout(timer);
  }, [decision?.id, decisionVisible]);

  useEffect(() => {
    if (focusTimer?.status !== "running") return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [focusTimer?.endsAt, focusTimer?.status]);

  const focus = focusTimer ? getCompanionFocusPetPresentation(focusTimer, clock) : null;
  // The native bubble is only 300 × 128 and ignores mouse input. Keep the
  // focus timer visible while showing several compact task rows at once, then
  // page any overflow instead of reducing the surface to one rotating task.
  const taskPageSize = focus ? 2 : 3;
  const taskPageCount = Math.max(1, Math.ceil(runningTasks.length / taskPageSize));
  const taskIds = JSON.stringify(runningTasks.map((task) => task.id));
  useEffect(() => {
    setTaskPage(0);
    if (taskPageCount < 2) return;
    const timer = window.setInterval(() => setTaskPage((page) => (page + 1) % taskPageCount), 5_000);
    return () => window.clearInterval(timer);
  }, [taskIds, taskPageCount]);
  const safeTaskPage = taskPage % taskPageCount;
  const firstVisibleTask = safeTaskPage * taskPageSize;
  const visibleTasks = runningTasks.slice(firstVisibleTask, firstVisibleTask + taskPageSize);
  const reminderVisible = decisionVisible && decision?.event === "todo.reminder";
  const visible = decisionVisible || focus !== null || runningTasks.length > 0;

  return (
    <main className={`${styles.surface}${visible ? ` ${styles.visible}` : ""}`}>
      {!reminderVisible && (focus || visibleTasks.length > 0) ? (
        <div
          className={`${styles.bubble} ${styles.statusStack}`}
          data-testid="companion-status-stack"
          role="status"
        >
          {focus ? (
            <div
              className={styles.focusRow}
              data-testid="companion-focus-timer-bubble"
              data-phase={focus.phase}
              data-status={focus.status}
              aria-label={`${t(`companion.focusTimer.${focus.phase}`)} ${formatCompanionFocusCountdown(focus.remainingSeconds)}`}
            >
              <span className={styles.timerPhase}>{t(`companion.focusTimer.${focus.phase}`)}</span>
              <small>{t(focus.status === "running" ? "companion.focusTimer.running" : "companion.focusTimer.paused")}</small>
              <strong>{formatCompanionFocusCountdown(focus.remainingSeconds)}</strong>
            </div>
          ) : null}
          {visibleTasks.map((task, index) => {
            const presentation = deriveCompanionTaskPresentation(task);
            const progress = getTaskProgress(task);
            const activityKind = presentation.activityKind;
            const activityLabel = t(`companion.agent.${activityKind === "assistant" ? "responding" : activityKind === "approval" ? "review" : activityKind}`);
            const taskMessage = task.activity?.message || task.errorSummary || t(`companion.activity.${presentation.status}Cause`);
            return (
              <div
                key={task.id}
                className={styles.taskRow}
                data-testid="companion-activity-bubble"
                data-session-id={task.id}
                data-status={presentation.status}
              >
                <span
                  className={styles.statusDot}
                  aria-hidden="true"
                  style={{ "--companion-row-status": TASK_STATUS_COLORS[presentation.status] } as CSSProperties}
                />
                <span className={styles.taskCopy}>
                  <span className={styles.taskHeading}>
                    <strong>{task.title || task.id.slice(0, 8)}</strong>
                    {taskPageCount > 1 && index === 0 ? (
                      <small>{firstVisibleTask + 1}–{Math.min(firstVisibleTask + taskPageSize, runningTasks.length)} / {runningTasks.length}</small>
                    ) : null}
                  </span>
                  <small className={styles.taskMessage}>{activityLabel}{progress.label ? ` · ${progress.label}` : ""} · {taskMessage}</small>
                </span>
              </div>
            );
          })}
        </div>
      ) : decisionVisible && decision?.speech ? <div className={styles.bubble} role="status">{decision.speech}</div> : null}
    </main>
  );
}
