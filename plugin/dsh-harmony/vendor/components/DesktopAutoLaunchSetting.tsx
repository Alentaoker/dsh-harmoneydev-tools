"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { DesktopAutoLaunchState } from "@/desktop/src/auto-launch";
import styles from "./SettingsDialog.module.css";

const UNSUPPORTED_STATE: DesktopAutoLaunchState = { supported: false, enabled: false };

export function DesktopAutoLaunchSetting() {
  const { t } = useI18n();
  const [state, setState] = useState<DesktopAutoLaunchState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const bridge = window.piDesktop?.getAutoLaunchState;
    if (!bridge) {
      setState(UNSUPPORTED_STATE);
      return;
    }
    try {
      setState(await bridge());
    } catch {
      setState({ supported: true, enabled: false, error: "read-failed" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async () => {
    const bridge = window.piDesktop?.setAutoLaunchEnabled;
    if (!bridge || !state?.supported || saving) return;
    setSaving(true);
    try {
      setState(await bridge(!state.enabled));
    } catch {
      setState((current) => ({
        supported: true,
        enabled: current?.enabled ?? false,
        error: "update-failed",
      }));
    } finally {
      setSaving(false);
    }
  };

  const description = state === null
    ? t("settings.autoLaunchLoading")
    : !state.supported
      ? t("settings.autoLaunchUnsupported")
      : state.error === "approval-required"
        ? t("settings.autoLaunchApprovalRequired")
        : state.error
          ? t("settings.autoLaunchFailed")
          : t("settings.autoLaunchDescription");

  return <div className={styles.conversationRow}>
    <div className={styles.conversationCopy}>
      <div className={styles.rowTitle}>{t("settings.autoLaunch")}</div>
      <div className={styles.rowDescription} role="status">{description}</div>
    </div>
    <button
      className={styles.switch}
      type="button"
      role="switch"
      aria-checked={state?.enabled ?? false}
      aria-label={t("settings.autoLaunch")}
      disabled={state === null || !state.supported || saving}
      onClick={() => { void toggle(); }}
    >
      <span />
    </button>
  </div>;
}
