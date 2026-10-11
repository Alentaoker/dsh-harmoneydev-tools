"use client";

import { useCallback, useEffect, useState } from "react";
import type { ExtensionUiRequest } from "@/lib/types";

export type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "request_user_input" | "select" | "confirm" | "input" | "editor" }>;
type CloseRequest = Extract<ExtensionUiRequest, { method: "close" }>;

/** Local expiry only dismisses UI. The server owns settlement of the tool. */
export function useExtensionDialog() {
  const [dialog, setDialog] = useState<ExtensionDialogRequest | null>(null);
  const receiveDialog = useCallback((request: ExtensionDialogRequest | CloseRequest) => {
    if (request.method === "close") {
      setDialog(current => current?.id === request.id ? null : current);
    } else if (!request.expiresAt || request.expiresAt > Date.now()) {
      setDialog(request);
    }
  }, []);
  useEffect(() => {
    if (!dialog?.expiresAt) return;
    const expiresAt = dialog.expiresAt;
    const dismiss = () => setDialog(current => current?.id === dialog.id ? null : current);
    const reconcile = () => { if (Date.now() >= expiresAt) dismiss(); };
    const timer = setTimeout(dismiss, Math.max(0, expiresAt - Date.now()));
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("focus", reconcile);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("focus", reconcile);
    };
  }, [dialog]);
  return { dialog, setDialog, receiveDialog };
}

export function useDialogCountdown(expiresAt?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 250);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : null;
}
