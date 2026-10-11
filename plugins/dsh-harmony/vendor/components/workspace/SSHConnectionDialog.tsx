"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SSHConnectionOptions, SSHSessionSnapshot } from "@/lib/ssh/types";
import { sshErrorText, sshRequest, SSHRequestError } from "@/lib/ssh/client";
import type { SSHSavedHost } from "@/lib/ssh/host-store";
import { AliIcon } from "../AliIcon";
import styles from "./SSHPanel.module.css";

export function SSHConnectionDialog({ onConnected, agentSessionId }: { onConnected: (snapshot: SSHSessionSnapshot) => void; agentSessionId?: string | null }) {
  const { t } = useI18n();
  const id = useId();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [hostName, setHostName] = useState("");
  const [saved, setSaved] = useState<SSHSavedHost[]>([]);
  const [vault, setVault] = useState<{ mode: "desktop" | "master-password"; configured: boolean; unlocked: boolean } | null>(null);
  const [masterPassword, setMasterPassword] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [authType, setAuthType] = useState<"password" | "privateKey">("password");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<"test" | "connect" | "save" | "vault" | "delete" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const keyFile = useRef<HTMLInputElement>(null);
  const settingsError = (error: unknown) => error instanceof SSHRequestError ? error.message : sshErrorText(error, t);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      sshRequest<{ hosts: SSHSavedHost[] }>("/api/ssh/hosts"),
      sshRequest<{ mode: "desktop" | "master-password"; configured: boolean; unlocked: boolean }>("/api/ssh/vault"),
    ]).then(([hosts, status]) => { if (alive) { setSaved(hosts.hosts); setVault(status); } })
      .catch(error => { if (alive) setResult({ ok: false, text: sshErrorText(error, t) }); });
    return () => { alive = false; };
  }, [t]);

  const postVault = async () => {
    if (busy || masterPassword.length < 8) return;
    setBusy("vault"); setResult(null);
    try {
      const status = await sshRequest<typeof vault>("/api/ssh/vault", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: vault?.configured ? "unlock" : "setup", password: masterPassword }) });
      setVault(status); setMasterPassword("");
      setResult({ ok: true, text: t("ssh.vaultReady") });
    } catch (error) { setResult({ ok: false, text: settingsError(error) }); }
    finally { setBusy(null); }
  };
  const lockVault = async () => {
    if (busy) return;
    setBusy("vault");
    try {
      const status = await sshRequest<NonNullable<typeof vault>>("/api/ssh/vault", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "lock" }) });
      setVault(status);
      setResult({ ok: true, text: t("ssh.vaultLocked") });
    } catch (error) { setResult({ ok: false, text: settingsError(error) }); }
    finally { setBusy(null); }
  };

  const saveHost = async () => {
    if (busy || !form.current?.reportValidity()) return;
    if (!hostName.trim() || (!editingId && !(authType === "password" ? password : privateKey))) { setResult({ ok: false, text: t("ssh.saveNeedsDetails") }); return; }
    setBusy("save"); setResult(null);
    const auth = authType === "password" ? { type: "password" as const, password } : { type: "privateKey" as const, privateKey, ...(passphrase ? { passphrase } : {}) };
    try {
      const payload = { name: hostName.trim(), host: host.trim(), port: Number(port), username: username.trim(), ...(!editingId || password || privateKey ? { auth } : {}) };
      const response = await sshRequest<{ host: SSHSavedHost }>(editingId ? "/api/ssh/hosts/" + editingId : "/api/ssh/hosts", { method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      setSaved(current => editingId ? current.map(item => item.id === editingId ? response.host : item) : [...current, response.host]);
      setEditingId(null); setPassword(""); setPrivateKey(""); setPassphrase("");
      setResult({ ok: true, text: t("ssh.saved") });
    } catch (error) { setResult({ ok: false, text: settingsError(error) }); }
    finally { setBusy(null); }
  };

  const connectSaved = async (id: string, testOnly: boolean) => {
    if (busy) return;
    setBusy(testOnly ? "test" : "connect"); setResult(null);
    try {
      const data = await sshRequest<{ snapshot: SSHSessionSnapshot }>("/api/ssh/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostId: id, testOnly, agentSessionId }) });
      if (testOnly) setResult({ ok: true, text: t("ssh.testSuccess") });
      else onConnected(data.snapshot);
    } catch (error) { setResult({ ok: false, text: sshErrorText(error, t) }); }
    finally { setBusy(null); }
  };

  const deleteHost = async (id: string) => {
    if (busy || !window.confirm(t("ssh.deleteHostConfirm"))) return;
    setBusy("delete"); setResult(null);
    try {
      await sshRequest("/api/ssh/hosts/" + id, { method: "DELETE" });
      setSaved(current => current.filter(item => item.id !== id));
      if (editingId === id) setEditingId(null);
    } catch (error) { setResult({ ok: false, text: settingsError(error) }); }
    finally { setBusy(null); }
  };

  const submit = async (testOnly: boolean) => {
    if (active.current || !form.current?.reportValidity()) return;
    if (editingId && !(password || privateKey)) { await connectSaved(editingId, testOnly); return; }
    const controller = new AbortController(); active.current = controller;
    setBusy(testOnly ? "test" : "connect"); setResult(null);
    const value: SSHConnectionOptions = { host: host.trim(), port: Number(port), username: username.trim(), auth: authType === "password" ? { type: "password", password } : { type: "privateKey", privateKey, ...(passphrase ? { passphrase } : {}) } };
    try {
      const data = await sshRequest<{ snapshot: SSHSessionSnapshot }>("/api/ssh/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...value, testOnly, agentSessionId }), signal: controller.signal });
      if (!controller.signal.aborted) {
        if (testOnly) setResult({ ok: true, text: t("ssh.testSuccess") });
        else onConnected(data.snapshot);
      }
    } catch (error) { if (!controller.signal.aborted) setResult({ ok: false, text: sshErrorText(error, t) }); }
    finally { if (active.current === controller) { active.current = null; setBusy(null); } }
  };

  return <div className={styles.connectPage}>
    {saved.length ? <section className={styles.savedHosts} aria-label={t("ssh.savedHosts")}>
      <div className={styles.savedHeading}><strong>{t("ssh.savedHosts")}</strong><span>{saved.length}</span></div>
      {saved.map(item => <div key={item.id} className={styles.savedRow}>
        <div className={styles.savedIdentity}><strong title={item.name}>{item.name}</strong><span title={item.username + "@" + item.host + ":" + item.port}>{item.username}@{item.host}:{item.port}</span></div>
        <button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void connectSaved(item.id, false)}>{t("ssh.connect")}</button>
        <button type="button" disabled={!!busy} title={t("ssh.editHost")} aria-label={t("ssh.editHost") + " " + item.name} onClick={() => { setEditingId(item.id); setHostName(item.name); setHost(item.host); setPort(String(item.port)); setUsername(item.username); setAuthType(item.authType); setPassword(""); setPrivateKey(""); setPassphrase(""); setResult(null); }}>{t("ssh.editHost")}</button>
        <button type="button" disabled={!!busy} title={t("ssh.deleteHost")} aria-label={t("ssh.deleteHost") + " " + item.name} onClick={() => void deleteHost(item.id)}>{t("ssh.deleteHost")}</button>
      </div>)}
    </section> : null}
    {vault?.mode === "master-password" ? <section className={styles.vaultBar} aria-label={t("ssh.vault")}>
      <div><strong>{t("ssh.vault")}</strong><p>{t(vault.unlocked ? "ssh.vaultUnlocked" : vault.configured ? "ssh.vaultUnlockHint" : "ssh.vaultSetupHint")}</p></div>
      {!vault.unlocked ? <form onSubmit={event => { event.preventDefault(); void postVault(); }}><input type="password" autoComplete={vault.configured ? "current-password" : "new-password"} minLength={8} value={masterPassword} onChange={event => setMasterPassword(event.target.value)} aria-label={t("ssh.masterPassword")} placeholder={t("ssh.masterPassword")} /><button className={styles.secondary} disabled={!!busy || masterPassword.length < 8} type="submit">{t(vault.configured ? "ssh.unlock" : "ssh.setupVault")}</button></form> : null}
      {vault.unlocked ? <button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void lockVault()}>{t("ssh.lockVault")}</button> : null}
    </section> : null}
    {vault?.mode === "desktop" ? <div className={styles.systemVault}>{t("ssh.systemVault")}</div> : null}
    <form ref={form} className={styles.connectForm} onChange={() => setResult(null)} onSubmit={event => { event.preventDefault(); void submit(false); }}>
      <div className={styles.connectMark}><AliIcon name="server" size={26} /></div>
      <h2>{t("ssh.title")}</h2><p className={styles.subtitle}>{t("ssh.subtitle")}</p>
      <fieldset disabled={busy !== null} className={styles.fields}>
        <label htmlFor={id + "-name"}>{t("ssh.hostName")}<input id={id + "-name"} value={hostName} onChange={event => setHostName(event.target.value)} placeholder={t("ssh.hostNamePlaceholder")} maxLength={80} /></label>
        <div className={styles.hostRow}>
          <label htmlFor={`${id}-host`}>{t("ssh.host")}<input id={`${id}-host`} value={host} onChange={event => setHost(event.target.value)} placeholder="server.example.com" required pattern="[^\s/]+" autoCapitalize="none" spellCheck={false} autoComplete="off" /></label>
          <label htmlFor={`${id}-port`}>{t("ssh.port")}<input id={`${id}-port`} value={port} onChange={event => setPort(event.target.value)} type="number" min={1} max={65535} step={1} required /></label>
        </div>
        <label htmlFor={`${id}-user`}>{t("ssh.username")}<input id={`${id}-user`} value={username} onChange={event => setUsername(event.target.value)} placeholder="deploy" required pattern=".*\S.*" autoCapitalize="none" spellCheck={false} autoComplete="username" /></label>
        <div><span className={styles.fieldLabel} id={`${id}-auth`}>{t("ssh.auth")}</span><div className={styles.segment} role="group" aria-labelledby={`${id}-auth`}>
          <button type="button" aria-pressed={authType === "password"} onClick={() => { setAuthType("password"); setResult(null); }}>{t("ssh.password")}</button>
          <button type="button" aria-pressed={authType === "privateKey"} onClick={() => { setAuthType("privateKey"); setResult(null); }}>{t("ssh.privateKey")}</button>
        </div></div>
        {authType === "password" ? <label htmlFor={`${id}-password`}>{t("ssh.password")}<div className={styles.passwordField}><input id={`${id}-password`} value={password} onChange={event => setPassword(event.target.value)} type={visible ? "text" : "password"} autoComplete="current-password" /><button type="button" onClick={() => setVisible(value => !value)} aria-label={t(visible ? "ssh.hide" : "ssh.show")}>{t(visible ? "ssh.hide" : "ssh.show")}</button></div></label> : <>
          <label htmlFor={`${id}-key`}>{t("ssh.privateKey")}<textarea id={`${id}-key`} value={privateKey} onChange={event => setPrivateKey(event.target.value)} rows={5} required={!editingId} spellCheck={false} placeholder={t("ssh.keyPlaceholder")} /></label>
          <input ref={keyFile} type="file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void (async () => { try { if (file.size > 1024 * 1024) throw new Error(t("ssh.error.key")); setPrivateKey(await file.text()); setResult(null); } catch (error) { setResult({ ok: false, text: sshErrorText(error, t) }); } })(); }} />
          <button type="button" className={styles.keyPicker} onClick={() => keyFile.current?.click()}><AliIcon name="folder-open" size={16} />{t("ssh.selectKey")}</button>
          <label htmlFor={`${id}-passphrase`}>{t("ssh.passphrase")}<input id={`${id}-passphrase`} value={passphrase} onChange={event => setPassphrase(event.target.value)} type="password" autoComplete="off" /></label>
        </>}
      </fieldset>
      {result ? <div role={result.ok ? "status" : "alert"} className={styles.feedback} data-success={result.ok}><AliIcon name={result.ok ? "check-circle" : "alert"} size={17} /><span>{result.text}</span></div> : null}
      <div className={styles.connectActions}>
        {editingId ? <button type="button" className={styles.secondary} disabled={!!busy} onClick={() => { setEditingId(null); setHostName(""); setHost(""); setPort("22"); setUsername(""); setPassword(""); setPrivateKey(""); setPassphrase(""); }}>{t("ssh.cancelEdit")}</button> : null}
        <button type="button" className={styles.secondary} disabled={!!busy || !vault?.unlocked} onClick={() => void saveHost()}>{busy === "save" ? <span className={styles.spinner} /> : null}{t(editingId ? "ssh.updateHost" : "ssh.saveHost")}</button>
        <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void submit(true)}>{busy === "test" ? <span className={styles.spinner} /> : <AliIcon name="link" size={16} />}{t(busy === "test" ? "ssh.testing" : "ssh.test")}</button>
        <button type="submit" className={styles.primary} disabled={busy !== null}>{busy === "connect" ? <span className={styles.spinner} /> : null}{t(busy === "connect" ? "ssh.connecting" : "ssh.connect")}{busy !== "connect" ? <AliIcon name="arrowright" size={16} /> : null}</button>
      </div>
      <p className={styles.formHint}>{editingId ? t("ssh.editCredentialHint") : t("ssh.testHint")}</p>
    </form>
  </div>;
}
