"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { NetworkProxyMode, NetworkProxySettings } from "@/lib/network-proxy";
import { AliIcon } from "./AliIcon";
import styles from "./NetworkProxySettings.module.css";

const DEFAULT_DRAFT: NetworkProxySettings = {
  mode: "system",
  proxyUrl: "",
  bypass: "localhost,127.0.0.1,::1",
};

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  return typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
}

export function NetworkProxySettings() {
  const { t } = useI18n();
  const [draft, setDraft] = useState<NetworkProxySettings>(DEFAULT_DRAFT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/network-proxy", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        const settings = await response.json() as NetworkProxySettings;
        setDraft(settings);
        await window.piDesktop?.setNetworkProxy?.(settings);
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const update = useCallback((patch: Partial<NetworkProxySettings>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setError(null);
    setResult(null);
  }, []);

  const saveAndApply = useCallback(async (): Promise<NetworkProxySettings> => {
    const response = await fetch("/api/network-proxy", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!response.ok) throw new Error(await responseError(response));
    const settings = await response.json() as NetworkProxySettings;
    const desktopApplied = await window.piDesktop?.setNetworkProxy?.(settings);
    if (desktopApplied === false) throw new Error(t("networkProxy.desktopApplyFailed"));
    setDraft(settings);
    setDirty(false);
    return settings;
  }, [draft, t]);

  const run = useCallback(async (action: "save" | "test") => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await saveAndApply();
      if (action === "save") {
        setResult(t("networkProxy.saved"));
        return;
      }
      const response = await fetch("/api/network-proxy", { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = await response.json() as { latencyMs?: number };
      setResult(t("networkProxy.testSucceeded", { latency: payload.latencyMs ?? 0 }));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }, [saveAndApply, t]);

  const modes: NetworkProxyMode[] = ["system", "manual", "direct"];

  return (
    <section className={styles.card} aria-labelledby="network-proxy-title">
      <div className={styles.heading}>
        <span className={styles.icon}><AliIcon name="earth" size={17} /></span>
        <div>
          <h3 id="network-proxy-title">{t("networkProxy.title")}</h3>
          <p>{t("networkProxy.description")}</p>
        </div>
      </div>

      <div className={styles.modes} role="radiogroup" aria-label={t("networkProxy.mode") }>
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={draft.mode === mode}
            className={styles.mode}
            data-selected={draft.mode === mode || undefined}
            disabled={loading || busy}
            onClick={() => update({ mode })}
          >
            <strong>{t(`networkProxy.mode.${mode}`)}</strong>
            <span>{t(`networkProxy.mode.${mode}Description`)}</span>
          </button>
        ))}
      </div>

      {draft.mode === "manual" ? (
        <div className={styles.fields}>
          <label>
            <span>{t("networkProxy.address")}</span>
            <input
              type="url"
              value={draft.proxyUrl}
              disabled={loading || busy}
              placeholder="http://127.0.0.1:7890"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => update({ proxyUrl: event.target.value })}
            />
          </label>
          <label>
            <span>{t("networkProxy.bypass")}</span>
            <input
              type="text"
              value={draft.bypass}
              disabled={loading || busy}
              placeholder="localhost,127.0.0.1,*.company.local"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => update({ bypass: event.target.value })}
            />
            <small>{t("networkProxy.bypassHint")}</small>
          </label>
        </div>
      ) : null}

      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {result ? <div className={styles.success} role="status">{result}</div> : null}

      <div className={styles.footer}>
        <p><AliIcon name="info" size={13} />{t("networkProxy.scope")}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={loading || busy} onClick={() => void run("test")}>
            {busy ? t("networkProxy.applying") : t("networkProxy.test")}
          </button>
          <button type="button" className={styles.primary} disabled={loading || busy || !dirty} onClick={() => void run("save")}>
            {busy ? t("networkProxy.applying") : t("networkProxy.save")}
          </button>
        </div>
      </div>
    </section>
  );
}
