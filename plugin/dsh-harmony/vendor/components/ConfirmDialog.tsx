"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/hooks/useI18n";
import styles from "./ConfirmDialog.module.css";

const CONFIRMATION_EVENT = "piora:request-confirmation";

export interface ConfirmationOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

interface ConfirmationRequest {
  options: ConfirmationOptions;
  resolve: (confirmed: boolean) => void;
}

export function requestConfirmation(options: ConfirmationOptions): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<ConfirmationRequest>(CONFIRMATION_EVENT, {
      detail: { options, resolve },
    }));
  });
}

export function ConfirmationHost() {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [queue, setQueue] = useState<ConfirmationRequest[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const activeRequest = queue[0] ?? null;

  const finish = useCallback((confirmed: boolean) => {
    setQueue((current) => {
      current[0]?.resolve(confirmed);
      return current.slice(1);
    });
  }, []);

  useFocusTrap(dialogRef, Boolean(activeRequest), {
    initialFocus: confirmRef,
    onEscape: activeRequest ? () => finish(false) : undefined,
  });

  useEffect(() => {
    setPortalTarget(document.body);
    const receive = (event: Event) => {
      const request = (event as CustomEvent<ConfirmationRequest>).detail;
      if (request?.options && typeof request.resolve === "function") {
        setQueue((current) => [...current, request]);
      }
    };
    window.addEventListener(CONFIRMATION_EVENT, receive);
    return () => window.removeEventListener(CONFIRMATION_EVENT, receive);
  }, []);

  if (!portalTarget || !activeRequest) return null;
  const { options } = activeRequest;

  return createPortal(
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(false); }}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-message">
        <div className={styles.body}>
          <h2 id="confirmation-title">{options.title ?? t("dialog.confirmTitle")}</h2>
          <p id="confirmation-message">{options.message}</p>
        </div>
        <div className={styles.actions}>
          <button type="button" onClick={() => finish(false)}>{options.cancelLabel ?? t("i18n.cancel")}</button>
          <button ref={confirmRef} type="button" className={options.tone === "danger" ? styles.danger : styles.primary} onClick={() => finish(true)}>{options.confirmLabel ?? t("dialog.confirm")}</button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
