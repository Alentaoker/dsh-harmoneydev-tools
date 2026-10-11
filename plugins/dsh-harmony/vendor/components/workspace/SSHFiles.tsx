"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SSHFileEntry } from "@/lib/ssh/types";
import { sshRequest, sshErrorText } from "@/lib/ssh/client";
import { AliIcon } from "../AliIcon";
import styles from "./SSHPanel.module.css";

const fileSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
const parentPath = (path: string) => path.replace(/\/$/, "").split("/").slice(0, -1).join("/") || "/";

export function SSHFiles({ sessionId, connected }: { sessionId: string; connected: boolean }) {
  const { t, locale } = useI18n();
  const [path, setPath] = useState(".");
  const [inputPath, setInputPath] = useState(".");
  const [entries, setEntries] = useState<SSHFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<{ name: string; status: "uploading" | "uploadSuccess" | "uploadFailed" | "downloading" | "downloadSuccess"; error?: string } | null>(null);
  const pathRef = useRef(".");
  const browse = useRef<AbortController | null>(null);
  const transferring = useRef<AbortController | null>(null);
  const retryFile = useRef<{ file: File; path: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const base = `/api/ssh/sessions/${encodeURIComponent(sessionId)}/files`;

  const load = useCallback(async (next: string) => {
    browse.current?.abort();
    const abort = new AbortController(); browse.current = abort;
    setLoading(true); setError(null);
    try {
      const result = await sshRequest<{ path: string; entries: SSHFileEntry[] }>(`${base}?path=${encodeURIComponent(next)}`, { signal: abort.signal });
      if (abort.signal.aborted) return;
      pathRef.current = result.path; setPath(result.path); setInputPath(result.path);
      setEntries(result.entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name)));
    } catch (cause) { if (!abort.signal.aborted) setError(sshErrorText(cause, t)); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }, [base, t]);
  useEffect(() => {
    if (connected) void load(pathRef.current);
    return () => browse.current?.abort();
  }, [load, connected]);
  useEffect(() => () => { transferring.current?.abort(); }, []);

  const upload = async (file: File, target = `${pathRef.current.replace(/\/$/, "")}/${file.name}`) => {
    if (transferring.current || !connected) return;
    retryFile.current = { file, path: target };
    if (file.size > 100 * 1024 * 1024) { setTransfer({ name: file.name, status: "uploadFailed", error: t("ssh.fileTooLarge") }); return; }
    const abort = new AbortController(); transferring.current = abort;
    setTransfer({ name: file.name, status: "uploading" });
    try {
      await sshRequest(`${base}/upload?path=${encodeURIComponent(target)}`, { method: "POST", body: file, signal: abort.signal });
      if (abort.signal.aborted) return;
      setTransfer({ name: file.name, status: "uploadSuccess" }); retryFile.current = null;
      void load(pathRef.current);
    } catch (cause) { if (!abort.signal.aborted) setTransfer({ name: file.name, status: "uploadFailed", error: sshErrorText(cause, t) }); }
    finally { if (transferring.current === abort) transferring.current = null; }
  };
  const download = async (entry: SSHFileEntry) => {
    if (transferring.current || !connected) return;
    const abort = new AbortController(); transferring.current = abort;
    setTransfer({ name: entry.name, status: "downloading" });
    try {
      const response = await fetch(`${base}/download?path=${encodeURIComponent(entry.path)}`, { signal: abort.signal });
      if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
      const blob = await response.blob();
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = entry.name; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setTransfer({ name: entry.name, status: "downloadSuccess" });
    } catch (cause) { if (!abort.signal.aborted) { setError(sshErrorText(cause, t)); setTransfer(null); } }
    finally { if (transferring.current === abort) transferring.current = null; }
  };
  const transferBusy = transfer?.status === "uploading" || transfer?.status === "downloading";
  const parts = path.split("/").filter(Boolean);
  return <section className={styles.files} aria-label={t("ssh.files")}>
    <header className={styles.filesHeader}><h3><AliIcon name="folder" size={20} />{t("ssh.files")}</h3><div className={styles.tools}>
      <button className={styles.secondary} disabled={!connected || loading} onClick={() => void load(path)} title={t("ssh.refresh")}><AliIcon name="reload" size={16} /><span>{t("ssh.refresh")}</span></button>
      <button className={styles.secondary} disabled={!connected || loading || path === "." || transferBusy} onClick={() => picker.current?.click()} title={t("ssh.upload")}><AliIcon name="upload" size={16} /><span>{t("ssh.upload")}</span></button>
      <input ref={picker} type="file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
    </div></header>
    <nav className={styles.breadcrumbs} aria-label={t("ssh.path")}><button disabled={!connected || loading} onClick={() => void load("/")}>/</button>{parts.map((part, index) => <span key={index}><button disabled={!connected || loading} title={part} onClick={() => void load(`/${parts.slice(0, index + 1).join("/")}`)}>{part}</button>{index < parts.length - 1 ? <span>/</span> : null}</span>)}</nav>
    <form className={styles.pathBar} onSubmit={event => { event.preventDefault(); if (connected && !loading) void load(inputPath.trim() || "."); }}>
      <button type="button" className={styles.secondary} title={t("ssh.up")} aria-label={t("ssh.up")} disabled={!connected || loading || path === "/"} onClick={() => void load(parentPath(path))}><AliIcon name="arrowup" size={17} /></button>
      <input aria-label={t("ssh.path")} value={inputPath} onChange={event => setInputPath(event.target.value)} disabled={!connected} spellCheck={false} />
      <button className={styles.pathGo} type="submit" title={t("ssh.go")} aria-label={t("ssh.go")} disabled={!connected || loading}><AliIcon name="arrowright" size={15} /></button>
    </form>
    {error ? <div className={styles.fileError} role="alert">{error}<button disabled={!connected || loading} onClick={() => void load(inputPath)}>{t("ssh.retry")}</button></div> : null}
    <div className={styles.fileList} aria-busy={loading}>
      <div className={`${styles.fileRow} ${styles.columnHead}`} aria-hidden="true"><span>{t("ssh.name")}</span><span className={styles.fileSize}>{t("ssh.size")}</span><span className={styles.modified}>{t("ssh.modified")}</span><span /></div>
      {loading ? <div className={styles.filePlaceholder} role="status">{t("ssh.loading")}</div> : entries.length === 0 && !error ? <div className={styles.filePlaceholder}>{t("ssh.empty")}</div> : null}
      {!loading ? entries.map(entry => <div className={styles.fileRow} key={entry.path}>
        {entry.type === "directory" ? <button className={styles.fileName} disabled={!connected} title={entry.name} onClick={() => void load(entry.path)}><AliIcon name="folder" size={18} /><span>{entry.name}</span></button> : <span className={styles.fileName} title={entry.name} tabIndex={0}><AliIcon name="file" size={18} /><span>{entry.name}</span></span>}
        <span className={styles.fileSize}>{entry.type === "directory" ? "—" : fileSize(entry.size)}</span>
        <time className={styles.modified} title={entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(locale) : ""}>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleDateString(locale, { month: "2-digit", day: "2-digit" }) : "—"}</time>
        {entry.type === "file" ? <button className={styles.iconButton} title={`${t("ssh.download")} ${entry.name}`} aria-label={`${t("ssh.download")} ${entry.name}`} disabled={!connected || transferBusy} onClick={() => void download(entry)}><AliIcon name="download" size={17} /></button> : <span />}
      </div>) : null}
    </div>
    {transfer ? <div className={styles.transfer} role={transfer.status === "uploadFailed" ? "alert" : "status"} data-failed={transfer.status === "uploadFailed"}>
      {transferBusy ? <span className={styles.spinner} /> : <AliIcon name={transfer.status === "uploadFailed" ? "alert" : "check-circle"} size={18} />}
      <span><span className={styles.transferName} title={transfer.name}>{transfer.name}</span> {t(`ssh.${transfer.status}`)}{transfer.error ? <small>{transfer.error}</small> : null}</span>
      {transfer.status === "uploadFailed" ? <button disabled={!connected} onClick={() => { if (retryFile.current) void upload(retryFile.current.file, retryFile.current.path); }}>{t("ssh.retry")}</button> : null}
    </div> : null}
    <footer className={styles.fileFooter}><span>{t("ssh.fileCount", { count: entries.length })}</span><span title={t("ssh.fileHint")}>{t("ssh.fileHint")}</span></footer>
  </section>;
}
