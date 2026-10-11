"use client";

import { useEffect, useState } from "react";
import type { GitAccount, HostingProvider } from "@/lib/git-accounts";
import type { HostingNamespace } from "@/lib/git-hosting";
import { useI18n } from "@/hooks/useI18n";
import styles from "./GitPushDialog.module.css";

interface Provider { provider: HostingProvider; site: string; }
interface Vault { mode: "desktop" | "master-password"; configured: boolean; unlocked: boolean; }
interface AccountsResponse { accounts: GitAccount[]; providers: Provider[]; vault: Vault; providerError?: string; }

async function request<T>(url: string, method = "GET", body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function GitHostingPanel({ cwd, remoteNames, onCreated }: {
  cwd: string;
  remoteNames: string[];
  onCreated: (name: string, url: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [accountsData, setAccountsData] = useState<AccountsResponse | null>(null);
  const [providerKey, setProviderKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [namespaces, setNamespaces] = useState<HostingNamespace[]>([]);
  const [namespaceId, setNamespaceId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [remoteName, setRemoteName] = useState(remoteNames.includes("origin") ? "publish" : "origin");
  const [password, setPassword] = useState("");
  const [operationId, setOperationId] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [created, setCreated] = useState<{ url: string; htmlUrl: string; bound: boolean; bindingError?: string } | null>(null);
  const [createOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = async () => {
    const data = await request<AccountsResponse>("/api/git/accounts");
    setAccountsData(data);
    setProviderKey((old) => data.providers.some((item) => `${item.provider}|${item.site}` === old) ? old
      : data.providers[0] ? `${data.providers[0].provider}|${data.providers[0].site}` : "");
    setAccountId((old) => data.accounts.some((item) => item.id === old) ? old : data.accounts[0]?.id ?? "");
  };
  useEffect(() => { void reload().catch((cause: unknown) => setError(String(cause))); }, []);
  useEffect(() => {
    if (!accountId) { setNamespaces([]); setNamespaceId(""); return; }
    let active = true;
    void request<{ namespaces: HostingNamespace[] }>(`/api/git/hosting?accountId=${encodeURIComponent(accountId)}`)
      .then((data) => { if (active) { setNamespaces(data.namespaces); setNamespaceId(data.namespaces[0]?.id ?? ""); } })
      .catch((cause: unknown) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [accountId]);
  useEffect(() => {
    if (!operationId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await request<{ status: "pending" | "ready" }>("/api/git/accounts", "POST", { action: "poll", operationId });
        if (cancelled) return;
        if (data.status === "ready") { setOperationId(""); setAuthorizationUrl(""); await reload(); return; }
        timer = setTimeout(() => void poll(), 2500);
      } catch (cause) {
        if (!cancelled) { setOperationId(""); setError(cause instanceof Error ? cause.message : String(cause)); }
      }
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [operationId]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const selectedProvider = accountsData?.providers.find((item) => `${item.provider}|${item.site}` === providerKey);
  const selectedAccount = accountsData?.accounts.find((item) => item.id === accountId);
  const giteePersonal = selectedAccount?.provider === "gitee" && namespaces.find((item) => item.id === namespaceId)?.kind === "user";
  return <div className={styles.hosting}>
    <h3>{t("review.createHostedRepository")}</h3>
    {accountsData?.providerError ? <p className={styles.note}>{accountsData.providerError}</p> : null}
    {accountsData?.vault && !accountsData.vault.unlocked ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      await request("/api/ssh/vault", "POST", { action: accountsData.vault.configured ? "unlock" : "setup", password });
      setPassword(""); await reload();
    }); }}>
      <label>{accountsData.vault.configured ? t("review.unlockVault") : t("review.setupVault")}
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
      </label>
      <button type="submit" disabled={busy || password.length < 8}>{t("review.vaultContinue")}</button>
    </form> : null}
    <div className={styles.hostingRow}>
      <select value={providerKey} disabled={busy || !accountsData?.vault.unlocked} onChange={(event) => setProviderKey(event.target.value)} aria-label={t("review.hostingProvider")}>
        {accountsData?.providers.map((item) => <option key={`${item.provider}|${item.site}`} value={`${item.provider}|${item.site}`}>{item.provider} · {item.site}</option>)}
      </select>
      <button type="button" disabled={busy || !selectedProvider || !accountsData?.vault.unlocked || !!operationId} onClick={() => void run(async () => {
        const browser = window.open("", "_blank");
        try {
          const data = await request<{ operationId: string; authorizationUrl: string }>("/api/git/accounts", "POST",
            { action: "start", provider: selectedProvider!.provider, site: selectedProvider!.site });
          setOperationId(data.operationId); setAuthorizationUrl(data.authorizationUrl);
          if (browser) browser.location.href = data.authorizationUrl;
        } catch (cause) { browser?.close(); throw cause; }
      })}>{operationId ? t("review.waitingForLogin") : t("review.connectAccount")}</button>
    </div>
    {authorizationUrl ? <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">{t("review.openAuthorizationPage")}</a> : null}
    {accountsData?.accounts.length ? <div className={styles.hostingRow}>
      <select value={accountId} disabled={!!created} onChange={(event) => setAccountId(event.target.value)} aria-label={t("review.hostingAccount")}>
        {accountsData.accounts.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
      </select>
      <button type="button" disabled={busy || !!created} onClick={() => void run(async () => {
        await request("/api/git/accounts", "DELETE", { id: accountId }); await reload();
      })}>{t("review.disconnectAccount")}</button>
    </div> : null}
    {accountId ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      const result = await request<{ created: boolean; bound: boolean; url: string; htmlUrl: string; bindingError?: string }>(
        "/api/git/hosting", "POST", { cwd, accountId, namespaceId, name, description, visibility, remoteName, operationId: createOperationId });
      setCreated(result);
      if (result.bound) await onCreated(remoteName, result.url);
    }); }}>
      <label>{t("review.repositoryOwner")}
        <select value={namespaceId} disabled={!!created} onChange={(event) => { setNamespaceId(event.target.value); if (selectedAccount?.provider === "gitee") setVisibility("private"); }}>
          {namespaces.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label>{t("review.repositoryName")}<input value={name} disabled={!!created} onChange={(event) => setName(event.target.value)} maxLength={100} /></label>
      <label>{t("review.repositoryDescription")}<input value={description} disabled={!!created} onChange={(event) => setDescription(event.target.value)} maxLength={500} /></label>
      <label>{t("review.repositoryVisibility")}
        <select value={visibility} disabled={!!created} onChange={(event) => setVisibility(event.target.value as "private" | "public")}>
          <option value="private">{t("review.privateRepository")}</option>
          <option value="public" disabled={giteePersonal}>{t("review.publicRepository")}</option>
        </select>
      </label>
      <label>{t("review.remoteName")}<input value={remoteName} onChange={(event) => setRemoteName(event.target.value)} /></label>
      <button type="submit" disabled={busy || !!created?.bound || !namespaceId || !name || !remoteName}>{created ? t("review.retryConnectRepository") : t("review.createAndConnectRepository")}</button>
    </form> : null}
    {created ? <p role="status">{created.bound ? t("review.repositoryCreated") : t("review.repositoryCreatedUnbound", { error: created.bindingError || "" })} <a href={created.htmlUrl} target="_blank" rel="noopener noreferrer">{created.htmlUrl}</a></p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </div>;
}
