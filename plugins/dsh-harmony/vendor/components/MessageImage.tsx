"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";

export function MessageImage({ src, index, onOpen }: { src: string; index: number; onOpen: () => void }) {
  const { t } = useI18n();
  const label = t("chat.openImage", { count: String(index + 1) });

  return (
    <button type="button" className="message-image-thumbnail" onClick={onOpen} title={label} aria-label={label}>
      {/* Session images can be base64 data URLs or provider URLs. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" />
    </button>
  );
}

export function MessageImageViewer({ src, index, onClose }: { src: string; index: number; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hasDesktopChrome = typeof window !== "undefined" && Boolean(window.piDesktop);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  const viewer = (
    <dialog
      ref={dialogRef}
      className="message-image-dialog"
      data-desktop-chrome={hasDesktopChrome ? "true" : undefined}
      aria-label={t("chat.imageViewer")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="message-image-dialog-layout">
        <div className="message-image-dialog-toolbar">
          <span>{t("chat.imageNumber", { count: String(index + 1) })}</span>
          <button type="button" onClick={onClose} title={t("i18n.close")} aria-label={t("i18n.close")}>
            <AliIcon name="close" size={15} />
          </button>
        </div>
        <button type="button" className="message-image-dialog-viewport" onClick={onClose} aria-label={t("chat.closeImageViewer")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" onClick={(event) => event.stopPropagation()} />
        </button>
      </div>
    </dialog>
  );

  return typeof document === "undefined" ? null : createPortal(viewer, document.body);
}
