"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useNativeShellConfig } from "@/hooks/useNativeShellConfig";
import { shellRequest } from "@/lib/shell/client";
import type { NativeShellSettings } from "@/lib/shell/types";
import styles from "./workspace/SmartShell.module.css";

export function SmartShellSettings({ cwd }: { cwd?: string }) {
  const { t } = useI18n();
  const [timeoutMinutes, setTimeoutMinutes] = useState<string | null>(null);
  const [savedMinutes, setSavedMinutes] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { config, error: profileLoadError } = useNativeShellConfig();
  const [shellDraft, setShellDraft] = useState<string | null>(null);
  const [shellSaving, setShellSaving] = useState(false);
  const [shellError, setShellError] = useState("");
  const [shellSaved, setShellSaved] = useState(false);
  const selectedShell = shellDraft ?? config?.executable ?? "";

  const saveDefaultShell = async () => {
    setShellSaving(true); setShellError(""); setShellSaved(false);
    try {
      await shellRequest<NativeShellSettings>("native-settings", { executable: selectedShell || null });
      setShellSaved(true);
      window.dispatchEvent(new Event("piora-native-shell-settings"));
    } catch (cause) { setShellError(String(cause)); }
    finally { setShellSaving(false); }
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/shell-timeout", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const settings = await response.json() as { timeoutSeconds: number };
        const minutes = String(settings.timeoutSeconds / 60);
        setTimeoutMinutes(minutes);
        setSavedMinutes(minutes);
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => controller.abort();
  }, []);

  const saveTimeout = async () => {
    const seconds = Math.round(Number(timeoutMinutes) * 60);
    if (!timeoutMinutes?.trim() || !Number.isFinite(seconds) || seconds < 1 || seconds > 2_147_483) {
      setError(t("shell.agentTimeoutInvalid"));
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/shell-timeout", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeoutSeconds: seconds }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const settings = await response.json() as { timeoutSeconds: number };
      const minutes = String(settings.timeoutSeconds / 60);
      setTimeoutMinutes(minutes);
      setSavedMinutes(minutes);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return <div className={styles.settings}>
    <header><h2>{t("shell.title")}</h2><p>{t("shell.description")}</p></header>
    <section className={styles.settingsSection} data-settings-id="shell.agentTimeout">
      <h3>{t("shell.agentTimeoutTitle")}</h3>
      <p>{t("shell.agentTimeoutDescription")}</p>
      <label className={styles.timeoutField}>
        <span>{t("shell.agentTimeoutMinutes")}</span>
        <input type="number" min={1 / 60} max={2_147_483 / 60} step="any" value={timeoutMinutes ?? ""}
          disabled={timeoutMinutes === null || saving}
          onChange={(event) => { setTimeoutMinutes(event.target.value); setError(null); setSaved(false); }} />
      </label>
      <div className={styles.timeoutActions}>
        <button type="button" className={styles.primary} disabled={timeoutMinutes === null || saving || timeoutMinutes === savedMinutes}
          onClick={() => void saveTimeout()}>{saving ? t("shell.agentTimeoutSaving") : t("shell.save")}</button>
        {saved ? <span role="status">{t("shell.agentTimeoutSaved")}</span> : null}
      </div>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
    </section>
    <section className={styles.settingsSection}>
      <h3>{t("shell.terminalSection")}</h3>
      <p>{t("shell.nativeProfileHint")}</p>
      <label className={styles.field} data-settings-id="shell.defaultShell">
        <span>{t("shell.defaultShell")}</span>
        <select value={selectedShell} disabled={!config || shellSaving}
          onChange={event => { setShellDraft(event.target.value); setShellError(""); setShellSaved(false); }}>
          <option value="">{t("shell.detectShell")}</option>
          {config?.executable && !config.profiles.some(profile => profile.executable === config.executable)
            ? <option value={config.executable}>{config.executable}</option> : null}
          {config?.profiles.map(profile => <option key={profile.executable} value={profile.executable}>{profile.label}{profile.bundled ? ` (${t("shell.bundled")})` : ""} — {profile.executable}</option>)}
        </select>
      </label>
      <div className={styles.timeoutActions}>
        <button type="button" className={styles.primary} disabled={!config || shellSaving || selectedShell === (config.executable ?? "")}
          onClick={() => void saveDefaultShell()}>{shellSaving ? t("shell.agentTimeoutSaving") : t("shell.save")}</button>
        {shellSaved ? <span role="status">{t("shell.defaultShellSaved")}</span> : null}
      </div>
      {shellError || profileLoadError ? <div className={styles.error} role="alert">{shellError || profileLoadError}</div> : null}
      {cwd ? <code>{cwd}</code> : null}
    </section>
    <section className={styles.settingsSection} data-settings-id="shell.history">
      <h3>{t("shell.history")}</h3>
      <p>{t("shell.nativeHistoryHint")}</p>
      <p>{t("shell.nativeKeys")}</p>
    </section>
  </div>;
}
