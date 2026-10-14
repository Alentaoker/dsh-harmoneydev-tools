"use client";
import { brandText, APP_DISPLAY_NAME } from "@/lib/branding";

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "pi-completion-notifications-enabled";
const MAX_TASK_TITLE_LENGTH = 80;
const MAX_SESSION_ID_LENGTH = 512;

export const NOTIFICATION_SESSION_EVENT = "piora:notification-session";

type DesktopNotificationBridge = {
  notifyCompletion?: (taskTitle?: string, sessionId?: string) => Promise<boolean>;
  notifyAutomation?: (taskTitle: string, status: "succeeded" | "failed" | "interrupted", sessionId?: string) => Promise<boolean>;
  notifyUserInput?: (taskTitle?: string, sessionId?: string) => Promise<boolean>;
};

export type CompletionNotificationCapability = "desktop" | "browser" | "unsupported";

function getDesktopNotificationBridge(): DesktopNotificationBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { piDesktop?: DesktopNotificationBridge }).piDesktop;
}

export function sanitizeCompletionTaskTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, MAX_TASK_TITLE_LENGTH).join("");
}

export function sanitizeNotificationSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_ID_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function attachBrowserNotificationNavigation(notification: Notification, sessionId: string | undefined): void {
  notification.onclick = () => {
    window.focus();
    notification.close();
    if (sessionId) {
      window.dispatchEvent(new CustomEvent(NOTIFICATION_SESSION_EVENT, { detail: sessionId }));
    }
  };
}

function getBrowserNotificationCopy(taskTitle: string | undefined): {
  title: string;
  body: string;
} {
  const isChinese = typeof navigator !== "undefined"
    && navigator.language.toLowerCase().startsWith("zh");
  return {
    title: taskTitle ? `${taskTitle} - ${APP_DISPLAY_NAME}` : brandText("Piora"),
    body: isChinese
      ? brandText("任务已完成，可以回到 Piora 查看结果。")
      : brandText("Task completed. Open Piora to review the result."),
  };
}

function getUserInputNotificationCopy(taskTitle: string | undefined): {
  title: string;
  body: string;
} {
  const isChinese = typeof navigator !== "undefined"
    && navigator.language.toLowerCase().startsWith("zh");
  return {
    title: taskTitle ? `${taskTitle} - ${APP_DISPLAY_NAME}` : brandText("Piora"),
    body: isChinese
      ? "模型提出了问题，正在等待你的回复。"
      : "The model asked a question and is waiting for your reply.",
  };
}

function readStoredPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredPreference(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

export function useCompletionNotification() {
  const [enabled, setEnabled] = useState(false);
  const [capability, setCapability] = useState<CompletionNotificationCapability>(
    "unsupported",
  );
  const enabledRef = useRef(false);

  const commitEnabled = useCallback((next: boolean) => {
    enabledRef.current = next;
    setEnabled(next);
    writeStoredPreference(next);
    return next;
  }, []);

  useEffect(() => {
    const desktopBridge = getDesktopNotificationBridge();
    if (desktopBridge?.notifyCompletion) {
      setCapability("desktop");
      commitEnabled(readStoredPreference());
      return;
    }

    if (typeof Notification === "undefined") {
      setCapability("unsupported");
      commitEnabled(false);
      return;
    }

    setCapability("browser");
    commitEnabled(readStoredPreference() && Notification.permission === "granted");
  }, [commitEnabled]);

  const setNotificationEnabled = useCallback(async (next: boolean): Promise<boolean> => {
    if (!next) return commitEnabled(false);

    const desktopBridge = getDesktopNotificationBridge();
    if (desktopBridge?.notifyCompletion) return commitEnabled(true);
    if (typeof Notification === "undefined") return commitEnabled(false);

    const permission = Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied" as const)
      : Notification.permission;
    return commitEnabled(permission === "granted");
  }, [commitEnabled]);

  const toggleNotification = useCallback(
    () => setNotificationEnabled(!enabledRef.current),
    [setNotificationEnabled],
  );

  const notifyCompletion = useCallback(async (taskTitle?: string, sessionId?: string): Promise<boolean> => {
    if (!enabledRef.current) return false;
    const safeTaskTitle = sanitizeCompletionTaskTitle(taskTitle);
    const safeSessionId = sanitizeNotificationSessionId(sessionId);

    const desktopBridge = getDesktopNotificationBridge();
    if (desktopBridge?.notifyCompletion) {
      try {
        return await desktopBridge.notifyCompletion(safeTaskTitle, safeSessionId);
      } catch {
        return false;
      }
    }

    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      commitEnabled(false);
      return false;
    }

    try {
      const copy = getBrowserNotificationCopy(safeTaskTitle);
      const notification = new Notification(copy.title, {
        body: copy.body,
        tag: "piora-task-complete",
      });
      attachBrowserNotificationNavigation(notification, safeSessionId);
      return true;
    } catch {
      return false;
    }
  }, [commitEnabled]);

  const notifyUserInput = useCallback(async (taskTitle?: string, sessionId?: string): Promise<boolean> => {
    if (!enabledRef.current) return false;
    const safeTaskTitle = sanitizeCompletionTaskTitle(taskTitle);
    const safeSessionId = sanitizeNotificationSessionId(sessionId);

    const desktopBridge = getDesktopNotificationBridge();
    if (desktopBridge?.notifyUserInput) {
      try {
        return await desktopBridge.notifyUserInput(safeTaskTitle, safeSessionId);
      } catch {
        return false;
      }
    }

    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      return false;
    }

    try {
      const copy = getUserInputNotificationCopy(safeTaskTitle);
      const notification = new Notification(copy.title, {
        body: copy.body,
        tag: "piora-user-input",
      });
      attachBrowserNotificationNavigation(notification, safeSessionId);
      return true;
    } catch {
      return false;
    }
  }, []);

  const notifyAutomation = useCallback(async (taskTitle: string, status: "succeeded" | "failed" | "interrupted", sessionId?: string): Promise<boolean> => {
    if (!enabledRef.current) return false;
    const safeTaskTitle = sanitizeCompletionTaskTitle(taskTitle) ?? brandText("Piora");
    const safeSessionId = sanitizeNotificationSessionId(sessionId);
    const desktopBridge = getDesktopNotificationBridge();
    if (desktopBridge?.notifyAutomation) {
      try { return await desktopBridge.notifyAutomation(safeTaskTitle, status, safeSessionId); } catch { return false; }
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      commitEnabled(false);
      return false;
    }
    const chinese = navigator.language.toLowerCase().startsWith("zh");
    const body = chinese
      ? status === "succeeded" ? brandText("定时任务已完成，可以回到 Piora 查看结果。") : status === "interrupted" ? brandText("定时任务因 Piora 重启而中断。") : brandText("定时任务执行失败，请回到 Piora 查看详情。")
      : status === "succeeded" ? brandText("Scheduled task completed. Open Piora to review the result.") : status === "interrupted" ? brandText("Scheduled task was interrupted when Piora restarted.") : brandText("Scheduled task failed. Open Piora to review the details.");
    try {
      const notification = new Notification(`${safeTaskTitle} - ${APP_DISPLAY_NAME}`, { body, tag: `piora-automation-${status}` });
      attachBrowserNotificationNavigation(notification, safeSessionId);
      return true;
    } catch { return false; }
  }, [commitEnabled]);

  return {
    notificationEnabled: enabled,
    notificationEnabledRef: enabledRef,
    notificationCapability: capability,
    setNotificationEnabled,
    onNotificationToggle: toggleNotification,
    notifyCompletion,
    notifyAutomation,
    notifyUserInput,
  };
}
