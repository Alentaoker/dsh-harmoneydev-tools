"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GitPushPreview, GitRemote } from "@/lib/git-remotes";
import type { GitAccount } from "@/lib/git-accounts";
import { GitHostingPanel } from "./GitHostingPanel";
import { requestConfirmation } from "../ConfirmDialog";
import styles from "./GitPushDialog.module.css";

interface Props {
  cwd: string;
  branch: string;
  upstream?: string | null;
  onClose: () => void;
  onPushed: () => void;
}

async function request<T>(url: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function GitPushDialog({ cwd, branch, upstream, onClose, onPushed }: Props) {
  const { t } = useI18n();
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [accounts, setAccounts] = useState<GitAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [remote, setRemote] = useState("");
  const [pushUrl, setPushUrl] = useState("");
  const [targetBranch, setTargetBranch] = useState(branch);
  const [preview, setPreview] = useState<GitPushPreview | null>(null);
  const [setUpstream, setSetUpstream] = useState(true);
  const [manage, setManage] = useState(false);
  const [createHosted, setCreateHosted] = useState(false);
  const [newName, setNewName] = useState("origin");
  const [newUrl, setNewUrl] = useState("");
  const [editingRemote, setEditingRemote] = useState("");
  const [editingName, setEditingName] = useState("");
  const [editingUrl, setEditingUrl] = useState("");
  const [editingPushUrl, setEditingPushUrl] = useState("");
  const [replacingPushUrl, setReplacingPushUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = remotes.find((item) => item.name === remote);
  const canSetUpstream = Boolean(chosen?.fetchUrls.includes(pushUrl));

  const reload = useCallback(async () => {
    const data = await request<{ remotes: GitRemote[] }>(`/api/git/remotes?cwd=${encodeURIComponent(cwd)}`, "GET");
    const accountData = await request<{ accounts: GitAccount[] }>("/api/git/accounts", "GET");
    setRemotes(data.remotes);
    setAccounts(accountData.accounts);
    setRemote((current) => data.remotes.some((item) => item.name === current)
      ? current : (data.remotes.find((item) => item.name === "origin")?.name ?? data.remotes[0]?.name ?? ""));
  }, [cwd]);

  useEffect(() => { void reload().catch((cause: unknown) => setError(String(cause))); }, [reload]);
  useEffect(() => {
    const selected = remotes.find((item) => item.name === remote);
    setPushUrl(selected?.pushUrls.length === 1 ? selected.pushUrls[0] : "");
    setPreview(null);
  }, [remote, remotes]);
  useEffect(() => { setPreview(null); }, [pushUrl, targetBranch]);
  useEffect(() => { setSetUpstream(!upstream && Boolean(chosen?.fetchUrls.includes(pushUrl))); }, [chosen, pushUrl, upstream]);
  const matchingAccounts = useMemo(() => accounts.filter((item) => {
    try { return new URL(pushUrl).hostname === new URL(item.site).hostname && new URL(pushUrl).protocol === "https:"; }
    catch { return false; }
  }), [accounts, pushUrl]);
  useEffect(() => {
    setAccountId(matchingAccounts.length === 1 ? matchingAccounts[0].id : "");
  }, [matchingAccounts]);
  useEffect(() => { setPreview(null); }, [accountId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={t("review.pushPreviewTitle")}>
      <header><h2>{t("review.pushPreviewTitle")}</h2><button type="button" disabled={busy} onClick={onClose} aria-label={t("review.closePush")}>×</button></header>
      <div className={styles.fields}>
        <label>{t("review.localBranch")}<strong>{branch}</strong></label>
        <label>{t("review.remoteRepository")}
          <select value={remote} disabled={busy} onChange={(event) => setRemote(event.target.value)}>
            {remotes.length === 0 ? <option value="">{t("review.noRemotes")}</option> : null}
            {remotes.map((item) => <option value={item.name} key={item.name}>{item.name}</option>)}
          </select>
        </label>
        {chosen && chosen.pushUrls.length > 1 ? <label>{t("review.pushAddress")}
          <select value={pushUrl} disabled={busy} onChange={(event) => setPushUrl(event.target.value)}>
            <option value="">{t("review.choosePushAddress")}</option>
            {chosen.pushUrls.map((url) => <option value={url} key={url}>{url}</option>)}
          </select>
        </label> : chosen?.pushUrls[0] ? <small className={styles.url}>{chosen.pushUrls[0]}</small> : null}
        {matchingAccounts.length ? <label>{t("review.pushAccount")}
          <select value={accountId} disabled={busy} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">{t("review.systemGitCredentials")}</option>
            {matchingAccounts.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
          </select>
        </label> : null}
        <label>{t("review.targetBranch")}<input value={targetBranch} disabled={busy} onChange={(event) => setTargetBranch(event.target.value)} /></label>
        <label className={styles.check}><input type="checkbox" checked={setUpstream} disabled={busy || !canSetUpstream} onChange={(event) => setSetUpstream(event.target.checked)} />{t("review.setUpstream")}</label>
      </div>
      <div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => setManage((value) => !value)}>{t("review.manageRemotes")}</button>
        <button type="button" disabled={busy} onClick={() => setCreateHosted((value) => !value)}>{t("review.createHostedRepository")}</button>
        <button type="button" disabled={busy || !remote || !pushUrl || !targetBranch} onClick={() => void run(async () => {
          const data = await request<GitPushPreview>("/api/git/push/preview", "POST", { cwd, remote, pushUrl, targetBranch, ...(accountId ? { accountId } : {}) });
          setPreview(data);
        })}>{t("review.refreshPushPreview")}</button>
      </div>
      {createHosted ? <GitHostingPanel cwd={cwd} remoteNames={remotes.map((item) => item.name)} onCreated={async (name) => {
        await reload(); setRemote(name); setCreateHosted(false); setManage(false);
      }} /> : null}
      {manage ? <div className={styles.manage}>
        <h3>{t("review.manageRemotes")}</h3>
        {remotes.map((item) => <div className={styles.remoteRow} key={item.name}>
          <span title={item.fetchUrls.join("\n")}>{item.name}</span>
          <button type="button" disabled={busy} onClick={() => { setEditingRemote(item.name); setEditingName(item.name); setEditingUrl(item.fetchUrls[0] ?? ""); setEditingPushUrl(item.pushUrls[0] ?? ""); setReplacingPushUrl(item.pushUrls[0] ?? ""); }}>{t("review.editRemote")}</button>
          <button type="button" disabled={busy} onClick={() => void run(async () => {
            if (!await requestConfirmation({ title: t("review.removeRemote"), message: t("review.removeRemoteConfirm", { name: item.name }),
              confirmLabel: t("review.removeRemote"), tone: "danger" })) return;
            await request("/api/git/remotes", "DELETE", { cwd, name: item.name });
            await reload();
          })}>{t("review.removeRemote")}</button>
        </div>)}
        {editingRemote ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await request("/api/git/remotes", "PATCH", { cwd, name: editingRemote, nextName: editingName, url: editingUrl,
            pushUrl: editingPushUrl, replacePushUrl: replacingPushUrl });
          setEditingRemote(""); await reload();
        }); }}>
          <input aria-label={t("review.remoteName")} value={editingName} onChange={(event) => setEditingName(event.target.value)} />
          <input aria-label={t("review.remoteUrl")} value={editingUrl} onChange={(event) => setEditingUrl(event.target.value)} />
          {(remotes.find((item) => item.name === editingRemote)?.pushUrls.length ?? 0) > 1 ? <select value={replacingPushUrl} onChange={(event) => { setReplacingPushUrl(event.target.value); setEditingPushUrl(event.target.value); }} aria-label={t("review.choosePushAddress")}>
            {remotes.find((item) => item.name === editingRemote)?.pushUrls.map((url) => <option key={url} value={url}>{url}</option>)}
          </select> : null}
          <input aria-label={t("review.pushAddress")} value={editingPushUrl} onChange={(event) => setEditingPushUrl(event.target.value)} />
          <button type="submit" disabled={busy}>{t("review.saveRemote")}</button>
        </form> : null}
        <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await request("/api/git/remotes", "POST", { cwd, name: newName, url: newUrl });
          setNewUrl(""); await reload();
        }); }}>
          <input aria-label={t("review.remoteName")} value={newName} onChange={(event) => setNewName(event.target.value)} />
          <input aria-label={t("review.remoteUrl")} value={newUrl} onChange={(event) => setNewUrl(event.target.value)} placeholder="https://… / git@host:…" />
          <button type="submit" disabled={busy || !newName || !newUrl}>{t("review.addRemote")}</button>
        </form>
      </div> : null}
      {preview ? <div className={styles.preview}>
        <strong>{t("review.pushRoute", { source: preview.branch, remote: preview.remote, target: preview.targetBranch })}</strong>
        <span>{t("review.pushCounts", { ahead: preview.ahead, behind: preview.behind })}</span>
        {preview.commits.length > 0 ? <ol>{preview.commits.map((item) => <li key={item.sha}><code>{item.sha.slice(0, 8)}</code> {item.subject}</li>)}</ol> : <p>{t("review.nothingToPush")}</p>}
      </div> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <footer>
        <button type="button" disabled={busy} onClick={onClose}>{t("review.cancelPush")}</button>
        <button type="button" disabled={busy || !preview || preview.behind > 0 || preview.ahead === 0} onClick={() => void run(async () => {
          await request("/api/git/push", "POST", { cwd, preview, setUpstream });
          onPushed(); onClose();
        })}>{busy ? t("review.pushWorking") : t("review.pushOnly")}</button>
      </footer>
    </section>
  </div>;
}
