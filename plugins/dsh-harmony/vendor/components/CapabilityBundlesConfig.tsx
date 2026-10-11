"use client";

import JSZip from "jszip";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import type { CapabilityBundleImportResult } from "@/lib/capability-bundles";
import { AliIcon } from "./AliIcon";
import styles from "./CapabilityBundlesConfig.module.css";

const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

interface BundlePreview {
  file: File;
  name: string;
  createdAt?: string;
  pluginCount: number;
  skillCount: number;
  extensionCount: number;
  warnings: string[];
}

function downloadName(response: Response): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  return disposition.match(/filename="([^"]+)"/i)?.[1] ?? "piora-capabilities.piora-bundle";
}

async function inspectBundle(file: File): Promise<BundlePreview> {
  if (file.size === 0 || file.size > MAX_BUNDLE_BYTES) throw new Error("size");
  const zip = await JSZip.loadAsync(file, { createFolders: false });
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("format");
  const manifest = JSON.parse(await manifestFile.async("string")) as Record<string, unknown>;
  if (manifest.format !== "piora-capability-bundle" || manifest.version !== 1) throw new Error("version");
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  const skills = Array.isArray(manifest.skills) ? manifest.skills : [];
  const extensionStates = Array.isArray(manifest.extensionStates) ? manifest.extensionStates : [];
  const warnings = Array.isArray(manifest.warnings)
    ? manifest.warnings.filter((item): item is string => typeof item === "string").slice(0, 20)
    : [];
  return {
    file,
    name: typeof manifest.name === "string" ? manifest.name : file.name,
    createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : undefined,
    pluginCount: plugins.length,
    skillCount: skills.length,
    extensionCount: extensionStates.length,
    warnings,
  };
}

export function CapabilityBundlesConfig({
  cwd,
  sessionId,
  onReloaded,
}: {
  cwd: string;
  sessionId: string | null;
  onReloaded?: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [result, setResult] = useState<CapabilityBundleImportResult | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      exportAbortRef.current?.abort();
      exportAbortRef.current = null;
    };
  }, []);

  const exportBundle = async () => {
    const controller = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = controller;
    setBusy("export");
    setErrorKey(null);
    setErrorDetail(null);
    setResult(null);
    try {
      const response = await fetch(`/api/capability-bundles?cwd=${encodeURIComponent(cwd)}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloadName(response);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
      setErrorKey("export");
      setErrorDetail(error instanceof Error ? error.message : String(error));
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
      if (mountedRef.current) setBusy(null);
    }
  };

  const chooseBundle = async (file: File | undefined) => {
    setPreview(null);
    setResult(null);
    setErrorKey(null);
    setErrorDetail(null);
    if (!file) return;
    try {
      setPreview(await inspectBundle(file));
    } catch (error) {
      setErrorKey(error instanceof Error && ["size", "version"].includes(error.message) ? error.message : "format");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const importBundle = async () => {
    if (!preview) return;
    setBusy("import");
    setErrorKey(null);
    setErrorDetail(null);
    setResult(null);
    try {
      const response = await fetch(`/api/capability-bundles?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.piora.capability-bundle+zip" },
        body: preview.file,
      });
      const body = await response.json() as CapabilityBundleImportResult & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      setResult(body);
      setPreview(null);
      window.dispatchEvent(new Event("piora:extensions-changed"));
      if (sessionId) {
        try {
          await sendAgentCommand(sessionId, { type: "reload" });
          onReloaded?.();
        } catch {
          // The import remains installed and is picked up by the next session reload.
        }
      }
    } catch (error) {
      setErrorKey("import");
      setErrorDetail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.surface}>
      <header className={styles.pageHeader}>
        <div>
          <h2>{t("capabilityBundles.title")}</h2>
          <p>{t("capabilityBundles.description")}</p>
        </div>
        <AliIcon name="export" size={22} />
      </header>

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="capability-bundle-export-title">
          <div className={styles.cardIcon}><AliIcon name="download" size={18} /></div>
          <h3 id="capability-bundle-export-title">{t("capabilityBundles.exportTitle")}</h3>
          <p>{t("capabilityBundles.exportDescription")}</p>
          {busy === "export" ? (
            <button type="button" className={styles.secondaryButton} onClick={() => exportAbortRef.current?.abort()}>
              <AliIcon name="close" size={14} />
              {t("i18n.cancel")}
            </button>
          ) : (
            <button type="button" className={styles.primaryButton} disabled={busy !== null} onClick={() => void exportBundle()}>
              <AliIcon name="download" size={14} />
              {t("capabilityBundles.export")}
            </button>
          )}
        </section>

        <section className={styles.card} aria-labelledby="capability-bundle-import-title">
          <div className={styles.cardIcon}><AliIcon name="import" size={18} /></div>
          <h3 id="capability-bundle-import-title">{t("capabilityBundles.importTitle")}</h3>
          <p>{t("capabilityBundles.importDescription")}</p>
          <button type="button" className={styles.secondaryButton} disabled={busy !== null} onClick={() => inputRef.current?.click()}>
            <AliIcon name="import" size={14} />
            {t("capabilityBundles.choose")}
          </button>
          <input
            ref={inputRef}
            className={styles.fileInput}
            type="file"
            accept=".piora-bundle,.zip,application/zip,application/vnd.piora.capability-bundle+zip"
            aria-label={t("capabilityBundles.choose")}
            onChange={(event) => void chooseBundle(event.target.files?.[0])}
          />
        </section>
      </div>

      <div className={styles.securityNote}>
        <AliIcon name="lock" size={14} />
        <div>
          <strong>{t("capabilityBundles.securityTitle")}</strong>
          <span>{t("capabilityBundles.security")}</span>
        </div>
      </div>

      {errorKey ? (
        <div className={styles.error} role="alert">
          {t(`capabilityBundles.error.${errorKey}`)}{errorDetail ? ` · ${errorDetail}` : ""}
        </div>
      ) : null}

      {preview ? (
        <section className={styles.preview} aria-labelledby="capability-bundle-preview-title">
          <div className={styles.previewHeader}>
            <div>
              <h3 id="capability-bundle-preview-title">{preview.name}</h3>
              <p>{preview.file.name}{preview.createdAt ? ` · ${new Date(preview.createdAt).toLocaleString()}` : ""}</p>
            </div>
            <button type="button" className={styles.iconButton} onClick={() => setPreview(null)} aria-label={t("i18n.close")}>
              <AliIcon name="close" size={13} />
            </button>
          </div>
          <div className={styles.stats}>
            <div><strong>{preview.pluginCount}</strong><span>{t("capabilityBundles.plugins")}</span></div>
            <div><strong>{preview.skillCount}</strong><span>{t("capabilityBundles.skills")}</span></div>
            <div><strong>{preview.extensionCount}</strong><span>{t("capabilityBundles.extensionStates")}</span></div>
          </div>
          <div className={styles.executionWarning}>
            <AliIcon name="warning" size={14} />
            {t("capabilityBundles.executionWarning")}
          </div>
          {preview.warnings.length > 0 ? (
            <details className={styles.warnings}>
              <summary>{t("capabilityBundles.exportWarnings", { count: preview.warnings.length })}</summary>
              <ul>{preview.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
            </details>
          ) : null}
          <div className={styles.previewActions}>
            <button type="button" className={styles.secondaryButton} disabled={busy !== null} onClick={() => setPreview(null)}>{t("i18n.cancel")}</button>
            <button type="button" className={styles.primaryButton} disabled={busy !== null} onClick={() => void importBundle()}>
              {busy === "import" ? t("capabilityBundles.importing") : t("capabilityBundles.apply")}
            </button>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className={styles.result} role="status" aria-live="polite">
          <div className={styles.resultTitle}><AliIcon name="check" size={15} />{t("capabilityBundles.imported", { name: result.name })}</div>
          <p>{t("capabilityBundles.importSummary", {
            plugins: result.summary.pluginsInstalled,
            skills: result.summary.skillsInstalled,
            extensions: result.summary.extensionStatesApplied,
          })}</p>
          {result.warnings.length > 0 ? (
            <details className={styles.warnings}>
              <summary>{t("capabilityBundles.importWarnings", { count: result.warnings.length })}</summary>
              <ul>{result.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
            </details>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
