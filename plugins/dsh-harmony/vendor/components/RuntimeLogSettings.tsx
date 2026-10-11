"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import styles from "./SettingsDialog.module.css";

export function RuntimeLogSettings() {
  const { t } = useI18n();
  const [info, setInfo] = useState<{ filePath: string; fileLoggingAvailable: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<"idle" | "copying" | "copied" | "opening" | "copyFailed" | "openFailed">("idle");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setInfo(null);
      setAction("idle");
      try {
        const result = await window.piDesktop?.getRuntimeLog?.();
        if (!cancelled) setInfo(result ?? null);
      } catch {
        if (!cancelled) setInfo(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [revision]);

  const copyPath = async () => {
    if (!info) return;
    setAction("copying");
    try {
      await copyText(info.filePath);
      setAction("copied");
    } catch {
      setAction("copyFailed");
    }
  };

  const revealLog = async () => {
    if (!info) return;
    setAction("opening");
    try {
      const opened = await window.piDesktop?.revealPath?.(info.filePath);
      setAction(opened ? "idle" : "openFailed");
    } catch {
      setAction("openFailed");
    }
  };

  const busy = loading || action === "copying" || action === "opening";
  return <section className={styles.conversationSection} data-settings-id="general.runtimeLog">
    <div className={styles.agentDataHeader}>
      <div className={styles.conversationCopy}>
        <div className={styles.rowTitle}>{t("settings.runtimeLog.title")}</div>
        <div className={styles.rowDescription}>{t("settings.runtimeLog.description")}</div>
      </div>
    </div>
    <div className={styles.agentDataBody}>
      {info ? <>
        <div className={styles.agentDataField}>
          <span>{t("settings.runtimeLog.path")}</span>
          <code className={styles.runtimeLogPath}>{info.filePath}</code>
        </div>
        <div className={styles.rowDescription} role="status">
          {t(info.fileLoggingAvailable ? "settings.runtimeLog.rotation" : "settings.runtimeLog.unwritable")}
        </div>
      </> : <div className={styles.rowDescription} role="status">
        {t(loading ? "settings.runtimeLog.loading" : "settings.runtimeLog.unavailable")}
      </div>}
      <div className={styles.agentDataActions}>
        <button type="button" className={styles.secondaryButton} disabled={!info || busy} onClick={() => { void copyPath(); }}>
          {t(action === "copied" ? "settings.runtimeLog.copied" : "settings.runtimeLog.copy")}
        </button>
        <button type="button" className={styles.secondaryButton} disabled={!info?.fileLoggingAvailable || busy} onClick={() => { void revealLog(); }}>
          {t("settings.runtimeLog.openFolder")}
        </button>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setRevision(value => value + 1)}>
          {t("settings.runtimeLog.refresh")}
        </button>
      </div>
      {action === "copyFailed" || action === "openFailed" ? <div className={styles.agentDataError} role="alert">
        {t(`settings.runtimeLog.${action}`)}
      </div> : null}
    </div>
  </section>;
}
